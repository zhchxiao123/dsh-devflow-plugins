import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assertionVerdict, explorationArtifacts, redactArtifacts } from '../src/official-evidence.ts'

let dir: string
let reports: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'official-evidence-')); reports = join(dir, 'midscene/report'); await mkdir(reports, { recursive: true }); await mkdir(join(dir, 'tmp')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const html = (dump: unknown) => `<script type="midscene_web_dump">${JSON.stringify(dump)}</script>`

it('distinguishes a completed boolean assertion from failed transport, unrelated and malformed tasks', async () => {
  await writeFile(join(reports, 'ignored.txt'), 'not a report')
  for (const dump of [null, [], {}, { executions: [null, {}, { tasks: [null, {}, { type: 'Log' },
    { type: 'Insight', subType: 'Assert', status: 'failed', output: false },
    { type: 'Insight', subType: 'Assert', status: 'finished', param: { dataDemand: 'other' }, output: false },
    { type: 'Insight', subType: 'Assert', status: 'finished', param: { dataDemand: 'expected' }, output: 'false' },
  ] }] }]) {
    await writeFile(join(reports, 'report.html'), html(dump))
    expect(await assertionVerdict(dir, 'expected')).toBeUndefined()
  }
  for (const output of [true, false]) {
    await writeFile(join(reports, 'report.html'), html({ executions: [{ tasks: [{ type: 'Insight', subType: 'Assert', status: 'finished', param: { dataDemand: 'expected' }, output }] }] }))
    expect(await assertionVerdict(dir, 'expected')).toBe(output)
  }
  await writeFile(join(reports, 'report.html'), 'broken')
  await expect(assertionVerdict(dir, 'expected')).rejects.toThrow('No dump')
})

it('rejects symlinked and oversized reports before parsing', async () => {
  await writeFile(join(dir, 'source'), html({}))
  await symlink(join(dir, 'source'), join(reports, 'linked.html'))
  await expect(assertionVerdict(dir, 'expected')).rejects.toThrow('Invalid official report')
  await rm(join(reports, 'linked.html'))
  await writeFile(join(reports, 'large.html'), '')
  await truncate(join(reports, 'large.html'), 64 * 1024 * 1024 + 1)
  await expect(assertionVerdict(dir, 'expected')).rejects.toThrow('Invalid official report')
})

it('scrubs textual artifacts and publishes only screenshots and HTML reports', async () => {
  await writeFile(join(reports, 'report.html'), 'secret')
  await writeFile(join(reports, 'plain.json'), '{}')
  await writeFile(join(dir, 'tmp/screenshot-1.jpeg'), 'pixels')
  await writeFile(join(dir, 'tmp/browser-endpoint'), 'private')
  await symlink(join(reports, 'report.html'), join(dir, 'unserved.html'))
  await symlink(join(reports, 'report.html'), join(reports, 'symlink.html'))
  await redactArtifacts(dir, text => text.replaceAll('secret', '[redacted]'))
  expect(await readFile(join(reports, 'report.html'), 'utf8')).toBe('[redacted]')
  expect(await explorationArtifacts(dir)).toEqual(['exploration.json', 'screenshots/screenshot-1.jpeg', 'reports/report.html'])
  expect(await readFile(join(dir, 'reports/report.html'), 'utf8')).toContain('data-devflow-report-storage')
  expect(await readFile(join(reports, 'report.html'), 'utf8')).toBe('[redacted]')
  await rm(reports, { recursive: true })
  expect(await explorationArtifacts(dir)).toEqual(['exploration.json', 'screenshots/screenshot-1.jpeg'])
  await writeFile(reports, 'not a directory')
  await expect(explorationArtifacts(dir)).rejects.toThrow()
})
