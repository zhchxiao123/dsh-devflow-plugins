/**
 * Evidence collection over a real temporary workspace. The point every case
 * here defends is that a declaration which stops matching says so: the globs
 * live in the manifest precisely so a renamed output directory surfaces on the
 * next red run instead of yielding a failure report with nothing in it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectEvidence } from '../src/evidence.ts'
import type { TestenvManifest } from '../src/types.ts'

const BASE: TestenvManifest = {
  services: [{ name: 'api', kind: 'process', up: 'run', ready: { probe: 'tcp', tcp: { host: '127.0.0.1', port: 1 } } }],
  test: 'run-tests',
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A workspace with the given files written into it, returning its absolute root. */
async function workspace(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'testenv-evidence-'))
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, contents)
  }
  return root
}

/** A Playwright json report naming one failed case with the given attachments. */
function reportWith(attachments: readonly { path: string; contentType: string }[]): string {
  return JSON.stringify({
    suites: [{
      specs: [{
        ok: false,
        title: 'checkout fails',
        file: 'checkout.spec.js',
        tests: [{ results: [{ error: { message: 'boom' }, attachments: attachments.map((entry, index) => ({ name: `a${index}`, ...entry })) }] }],
      }],
    }],
  })
}

describe('collectEvidence', () => {
  it('collects nothing at all when the manifest declares neither field', async () => {
    const cwd = await workspace({ 'test-results/shot.png': 'x' })
    expect(await collectEvidence(BASE, cwd)).toBeUndefined()
  })

  it('lists every matched file with its size, and types the ones worth showing inline', async () => {
    const cwd = await workspace({
      'test-results/shot.png': 'pretend png',
      'test-results/trace.zip': 'pretend zip',
    })
    const evidence = await collectEvidence({ ...BASE, evidence: ['test-results/**'] }, cwd)
    expect(evidence?.diagnostics).toEqual([])
    expect(evidence?.files).toEqual([
      { name: 'shot.png', path: join(cwd, 'test-results/shot.png'), bytes: 11, contentType: 'image/png' },
      { name: 'trace.zip', path: join(cwd, 'test-results/trace.zip'), bytes: 11 },
    ])
  })

  it('leaves directories out of the file list', async () => {
    const cwd = await workspace({ 'test-results/nested/shot.png': 'x' })
    const evidence = await collectEvidence({ ...BASE, evidence: ['test-results/**'] }, cwd)
    expect(evidence?.files.map(file => file.name)).toEqual(['shot.png'])
  })

  it('says so when a declaration matches nothing after a failed run', async () => {
    const cwd = await workspace({ 'other/shot.png': 'x' })
    const evidence = await collectEvidence({ ...BASE, evidence: ['test-results/**'] }, cwd)
    expect(evidence?.files).toEqual([])
    expect(evidence?.diagnostics[0]).toContain('matched no files after this failed run')
    expect(evidence?.diagnostics[0]).toContain('test-results/**')
  })

  it('reports the failed cases a declared report names', async () => {
    const cwd = await workspace({ 'out/report.json': reportWith([]) })
    const evidence = await collectEvidence(
      { ...BASE, report: { path: 'out/report.json', format: 'playwright-json' } },
      cwd,
    )
    expect(evidence?.diagnostics).toEqual([])
    expect(evidence?.failures.map(failure => failure.title)).toEqual(['checkout fails'])
  })

  it('names an unreadable report without touching the verdict', async () => {
    const cwd = await workspace({})
    const evidence = await collectEvidence(
      { ...BASE, report: { path: 'out/report.json', format: 'playwright-json' } },
      cwd,
    )
    expect(evidence?.failures).toEqual([])
    expect(evidence?.diagnostics[0]).toContain('could not be read')
    expect(evidence?.diagnostics[0]).toContain("the verdict below still comes from the test command's exit code")
  })

  it('prefixes a parse defect with the report it came from', async () => {
    const cwd = await workspace({ 'out/report.json': '{ not json' })
    const evidence = await collectEvidence(
      { ...BASE, report: { path: 'out/report.json', format: 'playwright-json' } },
      cwd,
    )
    expect(evidence?.diagnostics[0]).toMatch(/^out\/report\.json: the report is not parseable JSON: /)
  })

  it('adds the files a report attached, keeping the media type the runner declared', async () => {
    const cwd = await workspace({ 'out/report.json': '', 'shots/one.png': 'x' })
    const report = reportWith([{ path: join(cwd, 'shots/one.png'), contentType: 'image/webp' }])
    await writeFile(join(cwd, 'out/report.json'), report)
    const evidence = await collectEvidence(
      { ...BASE, evidence: ['shots/**'], report: { path: 'out/report.json', format: 'playwright-json' } },
      cwd,
    )
    // One file, not two: the glob and the report name the same path, and the
    // runner's own media type wins over the one guessed from the extension.
    expect(evidence?.files).toEqual([
      { name: 'one.png', path: join(cwd, 'shots/one.png'), bytes: 1, contentType: 'image/webp' },
    ])
  })

  it('drops an attached file that is no longer on disk', async () => {
    const cwd = await workspace({ 'out/report.json': '' })
    await writeFile(join(cwd, 'out/report.json'), reportWith([{ path: join(cwd, 'gone.png'), contentType: 'image/png' }]))
    const evidence = await collectEvidence(
      { ...BASE, report: { path: 'out/report.json', format: 'playwright-json' } },
      cwd,
    )
    expect(evidence?.files).toEqual([])
    expect(evidence?.failures).toHaveLength(1)
  })

  it('orders files by path so a truncated list is the same list every run', async () => {
    const cwd = await workspace({ 'out/b.png': 'x', 'out/a.png': 'x', 'out/c.png': 'x' })
    const evidence = await collectEvidence({ ...BASE, evidence: ['out/**'] }, cwd)
    expect(evidence?.files.map(file => file.name)).toEqual(['a.png', 'b.png', 'c.png'])
  })
})
