/** Real Git, HTTP authentication and report files exercise the final pre-commit seam without model/browser actions. */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { recheckAcceptance, retainRecheckSnapshot } from '../src/recheck.ts'
import { sha256, workspaceIdentity } from '../src/identity.ts'
import type { RunManifest, RunOptions } from '../src/types.ts'
const exec = promisify(execFile)
it.each(['suite.json', '.devflow/midscene/suites/0001-task.json'])('rechecks %s against real Git, authenticated HTTP and exact approved suite bytes', async (relativeSuite) => {
  const root = await mkdtemp(join(tmpdir(), 'midscene-final-recheck-'))
  let instance = 'initial'
  let duringProbe: (() => void) | undefined
  const server = createServer((request, response) => {
    if (request.headers.cookie !== 'session=private-test') { response.writeHead(401).end(); return }
    duringProbe?.()
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ buildId: 'build', instanceId: instance }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
    const workspace = join(await realpath(root), 'workspace')
    const output = join(root, 'reports'), runId = 'run'
    const directory = join(output, runId)
    await mkdir(workspace); await mkdir(directory, { recursive: true })
    const suite = join(workspace, relativeSuite)
    await mkdir(dirname(suite), { recursive: true })
    await writeFile(suite, JSON.stringify({ version: 1, name: 'final', baseUrl: `http://127.0.0.1:${address.port}`, buildProbe: { path: '/build', expected: 'build', format: 'json', field: ['buildId'], instanceField: ['instanceId'] }, cases: [{ id: 'case', steps: [{ kind: 'assert', prompt: 'visible' }] }] }))
    await exec('git', ['init', '-q'], { cwd: workspace })
    await exec('git', ['add', '.'], { cwd: workspace })
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: workspace })
    const manifest: RunManifest = { version: 1, runId, card: 'card', status: 'passed', startedAt: 'now', identity: { workspace, ...await workspaceIdentity(workspace), suiteSha256: sha256(await readFile(suite)), buildId: 'build', buildVerified: true, targetInstanceId: instance, model: 'fixture', midscene: '1.12.6', playwright: '1.63.0' }, counts: { cases: 1, completedCases: 1, assertions: 1, passedAssertions: 1, steps: 1, completedSteps: 1 }, results: [{ id: 'case', status: 'passed', completedSteps: 1, passedAssertions: 1, report: 'case-0.html', screenshot: 'case-0.png' }], cleanup: 'confirmed', usage: 'unavailable', reports: { markdown: 'test-report.md', html: 'report.html', results: 'results.json', baseUrl: pathToFileURL(directory + '/').href } }
    const options: RunOptions = { workspace, suite, output, card: 'card', buildId: 'build', model: 'fixture', timeoutMs: 5000, cleanupTimeoutMs: 100, maxSteps: 10 }
    retainRecheckSnapshot(manifest, { cookies: [{ name: 'session', value: 'private-test', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] })
    for (const path of ['manifest.json', 'report.html', 'test-report.md', 'results.json', 'case-0.html', 'case-0.png']) await writeFile(join(directory, path), 'fixture evidence')
    await recheckAcceptance(options, manifest)
    await rm(join(directory, 'case-0.html'))
    await expect(recheckAcceptance(options, manifest)).rejects.toThrow('reports unavailable before commit')
    await writeFile(join(directory, 'case-0.html'), 'fixture evidence')
    instance = 'restarted'
    await expect(recheckAcceptance(options, manifest)).rejects.toThrow('Build instance changed before commit')
    instance = 'initial'
    duringProbe = () => { appendFileSync(suite, '\n') }
    await expect(recheckAcceptance(options, manifest)).rejects.toThrow('changed during final')
    duringProbe = undefined
    await writeFile(suite, `${await readFile(suite, 'utf8')}\n`)
    if (relativeSuite.startsWith('.devflow/')) expect((await workspaceIdentity(workspace)).workspaceSha256).toBe(manifest.identity.workspaceSha256)
    await expect(recheckAcceptance(options, manifest)).rejects.toThrow('inputs changed')
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    await rm(root, { recursive: true, force: true })
  }
})
