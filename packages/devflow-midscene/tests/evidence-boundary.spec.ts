import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publicationAvailable } from '../src/publication.ts'
import { finalizeReports } from '../src/reports.ts'
import type { RunManifest } from '../src/types.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'midscene-evidence-boundary-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('published evidence', () => {
  it('rejects malformed or credential-bearing publication locations', async () => {
    for (const base of [undefined, 'not a URL', 'http://user@localhost/', 'http://user:password@localhost/', 'http://localhost/?token=secret', 'http://localhost/#fragment', 'ftp://localhost/']) {
      expect(await publicationAvailable(dir, base, ['report.html'], 100)).toBe(false)
    }
  })

  it('requires local links to resolve to this run and to nonempty files', async () => {
    const base = pathToFileURL(dir + '/').href
    await writeFile(join(dir, 'report.html'), '<h1>Evidence</h1>')
    expect(await publicationAvailable(dir, base, ['report.html'], 100)).toBe(true)
    expect(await publicationAvailable(dir, base, ['report.html'], 100, AbortSignal.abort())).toBe(false)
    await mkdir(join(dir, 'other-run'))
    await writeFile(join(dir, 'other-run', 'report.html'), '<h1>Other run</h1>')
    expect(await publicationAvailable(dir, new URL('other-run/', base).href, ['report.html'], 100)).toBe(false)
    expect(await publicationAvailable(dir, base, ['missing.html'], 100)).toBe(false)
    await writeFile(join(dir, 'report.html'), '')
    expect(await publicationAvailable(dir, base, ['report.html'], 100)).toBe(false)
  })

  it('requires the published bytes, rejects redirects and errors, and bounds a stalled response', async () => {
    const content = '<h1>This specific acceptance run</h1>'
    await writeFile(join(dir, 'report.html'), content)
    let mode: 'match' | 'wrong' | 'missing' | 'redirect' | 'stall' | 'cancel' = 'match'
    const cancellation = new AbortController()
    const server = createServer((_request, response) => {
      switch (mode) {
        case 'match': response.end(content); break
        case 'wrong': response.end('<h1>SPA fallback</h1>'); break
        case 'missing': response.writeHead(404).end(); break
        case 'redirect': response.writeHead(302, { location: '/other' }).end(); break
        case 'stall': break
        case 'cancel': cancellation.abort(); break
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
    const base = `http://127.0.0.1:${address.port}/`
    try {
      expect(await publicationAvailable(dir, base, ['report.html'], 1000)).toBe(true)
      for (const next of ['wrong', 'missing', 'redirect', 'stall'] as const) {
        mode = next
        expect(await publicationAvailable(dir, base, ['report.html'], 100)).toBe(false)
      }
      expect(await publicationAvailable(dir, base.replace('http:', 'https:'), ['report.html'], 100)).toBe(false)
      mode = 'cancel'
      const cancelledAt = Date.now()
      expect(await publicationAvailable(dir, base, ['report.html'], 5000, cancellation.signal)).toBe(false)
      expect(Date.now() - cancelledAt).toBeLessThan(1000)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })
})

function manifest(): RunManifest {
  return {
    version: 1, runId: 'evidence-run', card: '001-acceptance', status: 'passed',
    startedAt: '2026-09-14T00:00:00.000Z', endedAt: '2026-09-14T00:00:01.000Z',
    identity: {
      workspace: dir, commit: 'commit', workspaceSha256: 'workspace-hash', suiteSha256: 'suite-hash',
      buildId: '<build & "version">', buildVerified: true, model: 'fixture', midscene: '1.12.6', playwright: '1.63.0',
    },
    counts: { cases: 1, completedCases: 1, assertions: 1, passedAssertions: 1, steps: 1, completedSteps: 1 },
    results: [{ id: 'visible-heading', status: 'passed', completedSteps: 1, passedAssertions: 1, report: 'case-0.html', screenshot: 'case-0.png' }],
    cleanup: 'confirmed', usage: 'unavailable',
    reports: { markdown: 'test-report.md', html: 'report.html', results: 'results.json', baseUrl: pathToFileURL(dir + '/').href },
  }
}

describe('durable report finalization', () => {
  it('writes escaped HTML, copyable links, finite results and the terminal manifest', async () => {
    const record = manifest()
    await writeFile(join(dir, 'case-0.html'), '<h1>SDK report</h1>')
    await writeFile(join(dir, 'case-0.png'), 'screenshot bytes')
    await finalizeReports(dir, record)
    const markdown = await readFile(join(dir, 'test-report.md'), 'utf8')
    expect(markdown).toContain('Cases: 1/1; assertions: 1/1; steps: 1/1')
    expect(markdown).toContain(`[case-0.html](${new URL('case-0.html', record.reports.baseUrl).href})`)
    expect(await readFile(join(dir, 'report.html'), 'utf8')).toContain('&lt;build &amp; &quot;version&quot;&gt;')
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toEqual(record)
    expect(JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'))).toEqual(record.results)
  })

  it('retains partial results without inventing missing report links or an end time', async () => {
    const record = manifest()
    record.status = 'interrupted'
    delete record.endedAt
    record.results = [{ id: 'visible-heading', status: 'infrastructure-error', completedSteps: 0, passedAssertions: 0 }]
    await finalizeReports(dir, record)
    const markdown = await readFile(join(dir, 'test-report.md'), 'utf8')
    expect(markdown).toContain('Status: **interrupted**')
    expect(markdown).toContain('ended: unknown')
    expect(markdown).not.toContain('[case-0')
  })

  it('refuses empty or missing required case evidence before committing a terminal manifest', async () => {
    const record = manifest()
    await expect(finalizeReports(dir, record)).rejects.toThrow()
    await writeFile(join(dir, 'case-0.html'), '')
    await expect(finalizeReports(dir, record)).rejects.toThrow('Empty report')
    await expect(readFile(join(dir, 'manifest.json'))).rejects.toThrow()
  })
})
