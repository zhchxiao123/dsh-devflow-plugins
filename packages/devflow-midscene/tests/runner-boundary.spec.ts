/** IPC fault injection complements the actual SDK/browser suite; fake worker replies are not visual acceptance evidence. */
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { RunOptions, WorkerInput } from '../src/types.ts'

const boundary = vi.hoisted(() => ({
  fork: vi.fn(), terminate: vi.fn(), publication: vi.fn(), finalize: vi.fn(),
  write: vi.fn(), realpath: vi.fn(), identity: vi.fn(),
}))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), realpath: boundary.realpath }))
vi.mock('../src/identity.ts', async original => ({ ...await original<typeof import('../src/identity.ts')>(), workspaceIdentity: boundary.identity }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: boundary.fork }))
vi.mock('../src/process-tree.ts', () => ({ terminateOwnedTree: boundary.terminate }))
vi.mock('../src/publication.ts', () => ({ publicationAvailable: boundary.publication }))
vi.mock('../src/reports.ts', async (original) => {
  const actual = await original<typeof import('../src/reports.ts')>()
  boundary.finalize.mockImplementation(actual.finalizeReports)
  boundary.write.mockImplementation(actual.writeManifest)
  return { ...actual, finalizeReports: boundary.finalize, writeManifest: boundary.write }
})
import { runAcceptance } from '../src/runner.ts'
const exec = promisify(execFile)
let dir: string
let options: RunOptions
let fixture: (child: ProtocolChild, input: WorkerInput) => Promise<void>
class ProtocolChild extends EventEmitter {
  pid: number | undefined = 900001
  connected = true
  kill = vi.fn(() => { this.emit('close', 1); return true })
  send(message: WorkerInput | { type: 'cancel' }, callback: (error?: Error) => void): void {
    if ('type' in message) { callback(); return }
    queueMicrotask(() => { void fixture(this, message).catch((error: unknown) => this.emit('error', error)) })
    callback()
  }
}
async function finish(child: ProtocolChild, input: WorkerInput, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(input.runDir, 'case-0.html'), 'fixture report')
  await writeFile(join(input.runDir, 'case-0.png'), 'fixture screenshot')
  child.emit('message', { type: 'build-verified' })
  child.emit('message', { type: 'case-complete', result: {
    id: 'case', status: 'passed', completedSteps: 2, passedAssertions: 1,
    report: 'case-0.html', screenshot: 'case-0.png', ...overrides,
  } })
  child.emit('message', { type: 'finished', cleanup: 'confirmed' })
  child.emit('close', 0)
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'midscene-runner-protocol-'))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'suite.json'), JSON.stringify({ version: 1, name: 'protocol', baseUrl: 'http://127.0.0.1:3080', buildProbe: { path: '/build', expected: 'build' }, cases: [{ id: 'case', steps: [{ kind: 'goto', path: '/' }, { kind: 'assert', prompt: 'visible' }] }] }))
  await exec('git', ['init', '-q'], { cwd: workspace })
  await exec('git', ['add', '.'], { cwd: workspace })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: workspace })
  options = { workspace, suite: join(workspace, 'suite.json'), output: join(dir, 'outside'), card: 'card', buildId: 'build', model: 'fixture', timeoutMs: 1000, maxSteps: 10, cleanupTimeoutMs: 10 }
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  boundary.realpath.mockReset().mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).realpath)
  boundary.identity.mockReset().mockImplementation((await vi.importActual<typeof import('../src/identity.ts')>('../src/identity.ts')).workspaceIdentity)
  boundary.fork.mockReset().mockImplementation(() => new ProtocolChild())
  boundary.terminate.mockReset().mockResolvedValue(undefined)
  boundary.publication.mockReset().mockResolvedValue(true)
  fixture = finish
})

it('accepts only a complete worker result after publication and merges nullable usage', async () => {
  fixture = async (child, input) => {
    for (const message of [
      { type: 'browser-owned', pid: 900002 },
      { type: 'usage', promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      { type: 'usage', promptTokens: null, completionTokens: 2, totalTokens: null },
      { type: 'usage', promptTokens: 1, completionTokens: null, totalTokens: 3 },
      { type: 'case-start', index: 0 }, { type: 'step-start', index: 0, stepIndex: 0 },
    ]) child.emit('message', message)
    await finish(child, input)
  }
  vi.stubEnv('MIDSCENE_INSIGHT_MODEL_NAME', 'fixture')
  const progress = vi.fn()
  const result = await runAcceptance({ ...options, executablePath: '/fixture/browser', reportBaseUrl: 'https://reports.example/output', onProgress: progress })
  expect(result.status).toBe('passed')
  expect(result.usage).toEqual({ calls: 3, promptTokens: null, completionTokens: null, totalTokens: null })
  expect(progress).toHaveBeenCalledWith('step-start case=0 step=0')
})

it.each([
  null, 'bad', { type: 'unknown' }, { type: 'infrastructure-error' },
  { type: 'browser-owned', pid: 0 }, { type: 'browser-owned', pid: '123' },
  { type: 'usage', promptTokens: -1, completionTokens: 0, totalTokens: 0 },
  { type: 'usage', promptTokens: 1.1, completionTokens: 0, totalTokens: 0 },
  { type: 'case-complete', result: null }, { type: 'case-complete', result: {} },
])('refuses malformed or failure worker messages: %j', async (message) => {
  fixture = async (child, input) => { child.emit('message', message); await finish(child, input) }
  expect((await runAcceptance(options)).status).toBe('infrastructure-error')
})

it.each([
  { id: 1 }, { id: 'other' }, { status: 1 }, { status: 'invented' },
  { completedSteps: 1.1 }, { passedAssertions: 1.1 }, { completedSteps: -1 }, { completedSteps: 3 },
  { passedAssertions: -1 }, { passedAssertions: 2 }, { report: 1 }, { report: '../outside' },
  { screenshot: '../outside' }, { status: 'infrastructure-error' },
  { completedSteps: 1 }, { passedAssertions: 0 }, { report: undefined }, { screenshot: undefined },
])('refuses inconsistent case evidence: %j', async (overrides) => {
  fixture = (child, input) => finish(child, input, overrides)
  expect((await runAcceptance(options)).status).toBe('infrastructure-error')
})

it('rejects duplicated case results and unconfirmed cleanup', async () => {
  fixture = async (child, input) => {
    child.emit('message', { type: 'case-complete', result: { id: 'case', status: 'passed', completedSteps: 2, passedAssertions: 1 } })
    await finish(child, input)
  }
  expect((await runAcceptance(options)).status).toBe('infrastructure-error')
  fixture = async (child) => { child.emit('message', { type: 'finished', cleanup: 'unknown' }); child.emit('close', 0) }
  expect((await runAcceptance(options)).status).toBe('infrastructure-error')
})

it('records assertion failure distinctly and refuses missing build or case completion', async () => {
  fixture = (child, input) => finish(child, input, { status: 'assertion-failed', completedSteps: 1, passedAssertions: 0 })
  expect((await runAcceptance(options)).status).toBe('assertion-failed')
  fixture = async (child) => { child.emit('message', { type: 'finished', cleanup: 'confirmed' }); child.emit('close', 0) }
  expect((await runAcceptance(options)).status).toBe('infrastructure-error')
  fixture = async (child) => { child.emit('message', { type: 'build-verified' }); child.emit('message', { type: 'finished', cleanup: 'confirmed' }); child.emit('close', 0) }
  expect((await runAcceptance(options)).status).toBe('infrastructure-error')
})

it('retains interrupted evidence when the worker crashes or cannot start', async () => {
  fixture = async (child) => { child.emit('message', { type: 'browser-owned', pid: 900002 }); child.emit('close', 1) }
  expect((await runAcceptance(options)).status).toBe('interrupted')
  fixture = async (child) => { child.emit('error', new Error('spawn denied')) }
  expect((await runAcceptance(options)).status).toBe('interrupted')
})

it('does not start a browser for an already cancelled invocation', async () => {
  const signal = AbortSignal.abort()
  expect((await runAcceptance({ ...options, signal })).status).toBe('cancelled')
  expect(boundary.fork).not.toHaveBeenCalled()
})

it('escalates an unresponsive worker after cancellation and falls back if tree cleanup fails', async () => {
  const controller = new AbortController()
  fixture = async (child) => {
    child.emit('message', { type: 'browser-owned', pid: 900002 })
    boundary.terminate.mockImplementationOnce(async () => { child.emit('close', 1) })
    controller.abort()
  }
  expect((await runAcceptance({ ...options, signal: controller.signal })).status).toBe('cancelled')
  expect(boundary.terminate).toHaveBeenCalledWith(900001, 900002, 10)
  boundary.terminate.mockRejectedValueOnce(new Error('cleanup denied'))
  fixture = async () => {}
  expect((await runAcceptance({ ...options, timeoutMs: 5 })).status).toBe('timed-out')
})

it('does not publish success when summary publication or file persistence fails', async () => {
  boundary.publication.mockResolvedValueOnce(false)
  expect((await runAcceptance(options)).reason).toBe('Report publication unavailable')
  boundary.finalize.mockRejectedValueOnce(new Error('disk full'))
  const failed = await runAcceptance(options)
  expect(failed.reason).toBe('Report finalization failed')
  const persisted: unknown = JSON.parse(await readFile(join(options.output, failed.runId, 'manifest.json'), 'utf8'))
  expect(persisted).toMatchObject({ status: 'infrastructure-error' })
})

it('rejects invalid model identity and report destinations before browser work', async () => {
  vi.stubEnv('MIDSCENE_INSIGHT_MODEL_NAME', 'other')
  await expect(runAcceptance(options)).rejects.toThrow('Role-specific model conflicts')
  vi.stubEnv('MIDSCENE_INSIGHT_MODEL_NAME', '')
  for (const model of ['', 'line\nbreak']) await expect(runAcceptance({ ...options, model })).rejects.toThrow('Identity fields')
  for (const base of ['file:///tmp/', 'https://u:p@example.com/', 'https://example.com/?q=1', 'https://example.com/#x'])
    await expect(runAcceptance({ ...options, reportBaseUrl: base })).rejects.toThrow('Report base')
  expect(boundary.fork).not.toHaveBeenCalled()
})

it('treats a failed durable progress write as infrastructure failure', async () => {
  fixture = async (child, input) => {
    boundary.write.mockRejectedValueOnce(new Error('progress disk full'))
    await finish(child, input)
  }
  expect((await runAcceptance(options)).status).toBe('infrastructure-error')
})

it('cleans the independently known browser after unexpected worker death even if tree termination fails', async () => {
  boundary.terminate.mockRejectedValueOnce(new Error('cleanup failed'))
  fixture = async (child) => { child.emit('message', { type: 'browser-owned', pid: 900002 }); child.emit('close', 1) }
  const result = await runAcceptance(options)
  expect(result.status).toBe('interrupted')
  expect(result.cleanup).toBe('unknown')
  expect(boundary.terminate).toHaveBeenCalledWith(900001, 900002, 10)
})

it('handles IPC delivery failure before the worker receives its suite', async () => {
  boundary.fork.mockImplementationOnce(() => {
    const child = new ProtocolChild()
    child.send = (_message, callback) => { callback(new Error('IPC closed')) }
    return child
  })
  expect((await runAcceptance(options)).status).toBe('interrupted')
})

it('handles cancellation during worker creation without relying on a missed abort event', async () => {
  const controller = new AbortController()
  boundary.fork.mockImplementationOnce(() => {
    controller.abort()
    return new ProtocolChild()
  })
  expect((await runAcceptance({ ...options, signal: controller.signal })).status).toBe('cancelled')
})

it('does not send cancellation over disconnected IPC and tolerates absence of a spawned PID', async () => {
  boundary.fork.mockImplementationOnce(() => {
    const child = new ProtocolChild()
    child.connected = false
    child.pid = undefined
    return child
  })
  fixture = async (child) => { setTimeout(() => child.emit('close', 1), 30) }
  expect((await runAcceptance({ ...options, timeoutMs: 2, cleanupTimeoutMs: 2 })).status).toBe('timed-out')
})

it('keeps cancellation authoritative if the main deadline fires while cleanup is pending', async () => {
  const controller = new AbortController()
  fixture = async (child) => {
    controller.abort()
    setTimeout(() => child.emit('close', 1), 20)
  }
  expect((await runAcceptance({ ...options, signal: controller.signal, timeoutMs: 2, cleanupTimeoutMs: 50 })).status).toBe('cancelled')
})

it('returns cancellation when publication is aborted after successful execution', async () => {
  const controller = new AbortController()
  boundary.publication.mockImplementationOnce(async () => { controller.abort(); return false })
  expect((await runAcceptance({ ...options, signal: controller.signal })).status).toBe('cancelled')
})

it('returns timeout when report verification exceeds the invocation deadline', async () => {
  boundary.publication.mockImplementationOnce(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)
    return false
  })
  try { expect((await runAcceptance(options)).status).toBe('timed-out') }
  finally { vi.restoreAllMocks() }
})

it('inspects completed evidence and rejects missing files or inconsistent aggregate counts', async () => {
  const { inspectRun } = await import('../src/runner.ts')
  const result = await runAcceptance(options)
  const runDir = join(options.output, result.runId)
  expect((await inspectRun(runDir)).status).toBe('passed')
  const variants = [
    { counts: { ...result.counts, cases: 2 } },
    { counts: { ...result.counts, completedCases: 0 } },
    { counts: { ...result.counts, cases: 0 }, results: [] },
    { counts: { ...result.counts, completedSteps: 0 } },
    { counts: { ...result.counts, assertions: 0 } },
    { counts: { ...result.counts, passedAssertions: 0 } },
    { results: [{ ...result.results[0], status: 'assertion-failed' }] },
    { results: [{ ...result.results[0], report: undefined }] },
    { results: [{ ...result.results[0], screenshot: undefined }] },
    { cleanup: 'unknown' }, { endedAt: undefined },
  ]
  for (const variant of variants) {
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ ...result, ...variant }))
    expect((await inspectRun(runDir)).status).toBe('infrastructure-error')
  }
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(result))
  await rm(join(runDir, 'case-0.png'))
  expect((await inspectRun(runDir)).reportAvailable).toBe(false)
})

it('fails closed on output path resolution failures and symlink retargeting during directory creation', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  boundary.realpath.mockImplementationOnce(actual.realpath).mockImplementationOnce(actual.realpath).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(runAcceptance(options)).rejects.toThrow('denied')
  boundary.realpath.mockImplementationOnce(actual.realpath).mockImplementationOnce(actual.realpath).mockImplementationOnce(actual.realpath)
    .mockResolvedValueOnce(await actual.realpath(options.workspace))
  await expect(runAcceptance(options)).rejects.toThrow('Output must be outside')
})

it('rechecks cancellation and the deadline after the final workspace fingerprint', async () => {
  const actual = await vi.importActual<typeof import('../src/identity.ts')>('../src/identity.ts')
  const controller = new AbortController()
  boundary.identity.mockImplementationOnce(actual.workspaceIdentity).mockImplementationOnce(async (workspace: string) => {
    const identity = await actual.workspaceIdentity(workspace)
    controller.abort()
    return identity
  })
  expect((await runAcceptance({ ...options, signal: controller.signal })).status).toBe('cancelled')
  boundary.identity.mockImplementationOnce(actual.workspaceIdentity).mockImplementationOnce(async (workspace: string) => {
    const identity = await actual.workspaceIdentity(workspace)
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)
    return identity
  })
  expect((await runAcceptance(options)).status).toBe('timed-out')
  vi.restoreAllMocks()
})

it('rejects input mutations made while execution is in flight', async () => {
  const path = join(options.workspace, 'changed')
  fixture = async (child, input) => { await writeFile(path, 'mutation'); await finish(child, input) }
  try { expect((await runAcceptance(options)).reason).toBe('Inputs changed during execution') }
  finally { await rm(path, { force: true }) }
})

it('inspects running and partial histories without treating them as successful work', async () => {
  const { inspectRun } = await import('../src/runner.ts')
  const record = await runAcceptance(options)
  const runDir = join(options.output, record.runId)
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ ...record, status: 'running', reports: null }))
  expect((await inspectRun(runDir)).status).toBe('unknown')
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ ...record, status: 'interrupted', reports: 'invalid' }))
  expect((await inspectRun(runDir)).status).toBe('interrupted')
})

it('binds a private deployment receipt and passes scoped login/model settings only to its worker', async () => {
  const storageState = join(dir, 'private-login.json')
  const deploymentRecord = join(dir, 'private-deployment.json')
  const state = { cookies: [], origins: [] }
  await writeFile(storageState, JSON.stringify(state), { mode: 0o600 })
  const identity = await (await vi.importActual<typeof import('../src/identity.ts')>('../src/identity.ts')).workspaceIdentity(options.workspace)
  await writeFile(deploymentRecord, JSON.stringify({ version: 1, ...identity, buildId: 'build' }), { mode: 0o600 })
  fixture = async (child, input) => {
    expect(input.storageState).toEqual(state)
    expect(input).not.toHaveProperty('environment')
    await finish(child, input)
  }
  const environment = { MIDSCENE_MODEL_API_KEY: 'private-managed-token', MIDSCENE_INSIGHT_MODEL_NAME: 'fixture' }
  const result = await runAcceptance({ ...options, storageState, deploymentRecord, environment })
  expect(result.status).toBe('passed')
  expect(JSON.stringify(result)).not.toContain('private-managed-token')
  expect(boundary.fork.mock.calls[0]?.[2]).toMatchObject({ env: environment })
  await expect(runAcceptance({ ...options, environment: { MIDSCENE_INSIGHT_MODEL_NAME: 'other' } })).rejects.toThrow('conflicts')
})

it('records required target instance and rejects missing, empty, or non-string instance IPC', async () => {
  const source = await readFile(options.suite, 'utf8')
  const suite = JSON.parse(source) as { buildProbe: Record<string, unknown> }
  suite.buildProbe = { path: '/build', expected: 'build', format: 'json', field: ['buildId'], instanceField: ['instanceId'] }
  await writeFile(options.suite, JSON.stringify(suite))
  try {
    for (const targetInstanceId of [undefined, '', 42, 'instance']) {
      fixture = async (child, input) => {
        await writeFile(join(input.runDir, 'case-0.html'), 'fixture report')
        await writeFile(join(input.runDir, 'case-0.png'), 'fixture screenshot')
        child.emit('message', { type: 'build-verified', targetInstanceId })
        child.emit('message', { type: 'case-complete', result: { id: 'case', status: 'passed', completedSteps: 2, passedAssertions: 1, report: 'case-0.html', screenshot: 'case-0.png' } })
        child.emit('message', { type: 'finished', cleanup: 'confirmed' })
        child.emit('close', 0)
      }
      const result = await runAcceptance(options)
      expect(result.status).toBe(targetInstanceId === 'instance' ? 'passed' : 'infrastructure-error')
      if (targetInstanceId === 'instance') expect(result.identity.targetInstanceId).toBe('instance')
    }
  } finally { await writeFile(options.suite, source) }
})
