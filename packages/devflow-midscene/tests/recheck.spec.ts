import { beforeEach, expect, it, vi } from 'vitest'
import type { RunManifest, RunOptions, Suite } from '../src/types.ts'
const fixture = vi.hoisted(() => ({
  readFile: vi.fn(), realpath: vi.fn(), identity: vi.fn(), receipt: vi.fn(), context: vi.fn(), get: vi.fn(), dispose: vi.fn(),
  publication: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({ readFile: fixture.readFile, realpath: fixture.realpath }))
vi.mock('../src/identity.ts', () => ({ workspaceIdentity: fixture.identity, sha256: () => 'suite-hash', within: (parent: string, child: string) => child.startsWith(parent + '/') }))
vi.mock('../src/publication.ts', () => ({ publicationAvailable: fixture.publication }))
vi.mock('../src/deployment.ts', () => ({ verifyDeploymentRecord: fixture.receipt }))
vi.mock('playwright', () => ({ request: { newContext: fixture.context } }))
import { recheckAcceptance, retainRecheckSnapshot } from '../src/recheck.ts'
let suite: Suite
let manifest: RunManifest
let options: RunOptions
beforeEach(() => {
  vi.resetAllMocks()
  fixture.publication.mockResolvedValue(true)
  suite = { version: 1, name: 'recheck', baseUrl: 'http://localhost:3082', buildProbe: { path: '/build', expected: 'build', format: 'json', field: ['buildId'], instanceField: ['instanceId'] }, cases: [{ id: 'case', steps: [{ kind: 'assert', prompt: 'ok' }] }] }
  options = { workspace: '/workspace', suite: '/suite', output: '/output', card: 'card', buildId: 'build', model: 'model', timeoutMs: 1000, maxSteps: 10, cleanupTimeoutMs: 100 }
  manifest = { version: 1, runId: 'run', card: 'card', status: 'passed', startedAt: 'now', identity: { workspace: '/workspace', commit: 'commit', workspaceSha256: 'source', suiteSha256: 'suite-hash', buildId: 'build', buildVerified: true, targetInstanceId: 'original-process', model: 'model', midscene: '1.12.6', playwright: '1.63.0' }, counts: { cases: 1, completedCases: 1, assertions: 1, passedAssertions: 1, steps: 1, completedSteps: 1 }, results: [], cleanup: 'confirmed', usage: 'unavailable', reports: { markdown: '', html: '', results: '', baseUrl: '' } }
  fixture.realpath.mockImplementation((path: string) => Promise.resolve(path))
  fixture.identity.mockResolvedValue({ commit: 'commit', workspaceSha256: 'source' })
  fixture.readFile.mockImplementation(() => Promise.resolve(Buffer.from(JSON.stringify(suite))))
  fixture.context.mockResolvedValue({ get: fixture.get, dispose: fixture.dispose })
  fixture.get.mockResolvedValue({ ok: () => true, url: () => suite.baseUrl, text: () => Promise.resolve(JSON.stringify({ buildId: 'build', instanceId: 'original-process' })) })
  retainRecheckSnapshot(manifest, undefined)
})
it('rejects target restart after acceptance but before commit, and always disposes request context', async () => {
  await recheckAcceptance(options, manifest)
  fixture.get.mockResolvedValue({ ok: () => true, url: () => suite.baseUrl, text: () => Promise.resolve(JSON.stringify({ buildId: 'build', instanceId: 'restarted-process' })) })
  await expect(recheckAcceptance(options, manifest)).rejects.toThrow('Build instance changed before commit')
  expect(fixture.dispose).toHaveBeenCalledTimes(2)
})
it('retains the exact login snapshot and remaining budget while rechecking the deployment receipt', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(125)
  try {
    const state = { cookies: [], origins: [] }
    retainRecheckSnapshot(manifest, state)
    await recheckAcceptance({ ...options, storageState: '/changed-file', deploymentRecord: '/receipt' }, manifest)
    expect(fixture.context).toHaveBeenCalledWith({ storageState: state, timeout: 875 })
    expect(fixture.receipt).toHaveBeenCalledWith('/receipt', '/workspace', { commit: 'commit', workspaceSha256: 'source' }, 'build')
    expect(fixture.readFile).toHaveBeenCalledTimes(1)
  } finally { now.mockRestore() }
})
it('fails closed for reconstructed evidence, failed runs, missing instance, cancellation, and changed inputs', async () => {
  await expect(recheckAcceptance(options, structuredClone(manifest))).rejects.toThrow('Live acceptance')
  manifest.status = 'infrastructure-error'
  await expect(recheckAcceptance(options, manifest)).rejects.toThrow('Live acceptance')
  manifest.status = 'passed'
  delete manifest.identity.targetInstanceId
  await expect(recheckAcceptance(options, manifest)).rejects.toThrow('Live acceptance')
  manifest.identity.targetInstanceId = 'original-process'
  await expect(recheckAcceptance({ ...options, signal: AbortSignal.abort() }, manifest)).rejects.toThrow('cancelled')
  for (const field of ['workspace', 'commit', 'workspaceSha256', 'suiteSha256', 'buildId'] as const) {
    const saved = manifest.identity[field]; manifest.identity[field] = 'changed'
    await expect(recheckAcceptance(options, manifest)).rejects.toThrow('inputs changed')
    manifest.identity[field] = saved
  }
  suite.buildProbe.expected = 'changed'
  await expect(recheckAcceptance(options, manifest)).rejects.toThrow('inputs changed')
  suite.buildProbe.expected = 'build'
  delete suite.buildProbe.instanceField
  await expect(recheckAcceptance(options, manifest)).rejects.toThrow('inputs changed')
})
it('honors cancellation that arrives while the final probe is in flight', async () => {
  const controller = new AbortController()
  fixture.get.mockImplementation(() => { controller.abort(); return { ok: () => true, url: () => suite.baseUrl, text: () => Promise.resolve(JSON.stringify({ buildId: 'build', instanceId: 'original-process' })) } })
  await expect(recheckAcceptance({ ...options, signal: controller.signal }, manifest)).rejects.toThrow('cancelled')
  expect(fixture.dispose).toHaveBeenCalledOnce()
})

it('rejects suites resolving into excluded runtime state', async () => {
  fixture.realpath.mockResolvedValueOnce('/workspace').mockResolvedValueOnce('/workspace/.devflow/suite.json')
  await expect(recheckAcceptance(options, manifest)).rejects.toThrow('Suite must be outside')
})

it('refuses missing report assets after approval and checks the original manifest artifact list', async () => {
  manifest.results = [{ id: 'case', status: 'passed', completedSteps: 1, passedAssertions: 1, report: 'case-0.html', screenshot: 'case-0.png' }]
  fixture.publication.mockResolvedValue(false)
  await expect(recheckAcceptance(options, manifest)).rejects.toThrow('reports unavailable before commit')
  expect(fixture.publication).toHaveBeenCalledWith('/output/run', '', ['manifest.json', 'report.html', 'test-report.md', 'results.json', 'case-0.html', 'case-0.png'], expect.any(Number), undefined)
})
it('refuses a probe that consumes the final deadline without starting report publication', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1001)
  try { await expect(recheckAcceptance(options, manifest)).rejects.toThrow('reports unavailable before commit') }
  finally { now.mockRestore() }
  expect(fixture.publication).not.toHaveBeenCalled()
})
it('omits absent case artifact names when rechecking finite manifest paths', async () => {
  manifest.results = [{ id: 'case', status: 'passed', completedSteps: 1, passedAssertions: 1 }]
  await recheckAcceptance(options, manifest)
  expect(fixture.publication).toHaveBeenCalledWith('/output/run', '', ['manifest.json', 'report.html', 'test-report.md', 'results.json'], expect.any(Number), undefined)
})
