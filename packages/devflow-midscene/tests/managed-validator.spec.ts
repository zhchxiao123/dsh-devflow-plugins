import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { recoverExploration } from '../src/recovery.ts'
import { exploreBrowser } from '../src/browser.ts'
import { resolveModel } from '../src/model.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { JobRegistry, JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobStart } from '@deepseek-ai/dsh-jobs'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { GateValidationRequest, GateValidator } from '@zhchxiao123/dsh-devflow-gates'
import { emptyInbox } from '../../../tests/agent-double.ts'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { registerManagedValidators, registerManagedTools, runManaged } from '../src/managed.ts'
import { startDshModelBridge, checkDshModel } from '../src/model-bridge.ts'
import { writeSettings } from '../src/project-settings.ts'
import { resolveProjectProfile } from '../src/project-runtime.ts'
import { sha256, workspaceIdentity } from '../src/identity.ts'
import { runAcceptance, inspectRun, recheckAcceptance } from '../src/runner.ts'
import type { AcceptanceProfile } from '../src/config.ts'
import type { RunManifest } from '../src/types.ts'

vi.mock('../src/report-archive.ts', () => ({ archiveRun: vi.fn(async () => ({ htmlFiles: ['artifacts/midscene/run/report.html'], html: '.devflow/tasks/0001-check/artifacts/midscene/run/report.html', attachment: '# Report', purpose: 'acceptance' })) }))

vi.mock('../src/model-bridge.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/model-bridge.ts')>(), checkDshModel: vi.fn(async () => 'available'), startDshModelBridge: vi.fn(async () => ({ environment: {}, redact: (text: string) => text, capability: 'available', dispose: vi.fn() })) }))
vi.mock('../src/identity.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/identity.ts')>(), workspaceIdentity: vi.fn() }))
vi.mock('../src/model.ts', () => ({ resolveModel: vi.fn(async () => ({ environment: {}, redact: (text: string) => text, capability: 'available' })) }))
vi.mock('../src/recovery.ts', () => ({ recoverExploration: vi.fn() }))
vi.mock('../src/browser.ts', () => ({ exploreBrowser: vi.fn() }))
vi.mock('../src/runner.ts', () => ({ runAcceptance: vi.fn(), inspectRun: vi.fn(), recheckAcceptance: vi.fn() }))

/** Captures the published producer hooks; job ownership resolution remains the actual agent registry. */
class CapturingJobs extends JobRegistry {
  starts: JobStart[] = []
  hooks: JobHooks[] = []
  start(spec: JobStart): JobId { this.starts.push(spec); this.hooks.push(spec.run()); return JobId(`midscene-${this.starts.length}`) }
  list(): never { throw new Error('unused') }
  get(): never { throw new Error('unused') }
  read(): never { throw new Error('unused') }
  kill(): never { throw new Error('unused') }
  wait(): never { throw new Error('unused') }
  onJobDone(): never { throw new Error('unused') }
  onJobsChanged(): never { throw new Error('unused') }
  attachController(): never { throw new Error('unused') }
}
let ctx: Context
let dir: string
let p: AcceptanceProfile
let owner: Agent
let jobs: CapturingJobs
let disposeJobs: () => Promise<void>
let removeValidators: () => void
let request: GateValidationRequest
let manifest: RunManifest
const validators = new Map<string, GateValidator>()
const SUITE = JSON.stringify({ version: 1, name: 'acceptance', baseUrl: 'http://localhost:3000/app/',
  buildProbe: { path: '/build', expected: 'build' }, cases: [{ id: 'one', steps: [{ kind: 'assert', prompt: 'visible' }] }] })

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'midscene-managed-gate-')))
  const workspace = join(dir, 'workspace')
  await mkdir(join(workspace, '.devflow'), { recursive: true })
  await writeFile(join(workspace, 'suite.json'), SUITE)
  p = { workspace, output: join(dir, 'output'), model: 'vision', family: 'vl', baseUrl: 'https://model.test/v1',
    targetUrl: 'http://localhost:3000', reportBaseUrl: 'http://localhost:3082', browserMode: 'puppeteer', timeoutMs: 1000, cleanupTimeoutMs: 100, maxSteps: 10,
    suite: 'suite.json', suiteSha256: sha256(Buffer.from(SUITE)), buildId: 'build', deploymentRecord: join(dir, 'deployment.json') }
  ctx = new Context()
  removeValidators = ctx.provide('devflowValidators', { register: (name, run) => { validators.set(name, run); return () => { validators.delete(name) } } })
  await ctx.plugin(AgentRegistry).await()
  const id = SessionId('gate-owner')
  const scope = ctx.plugin(() => {})
  const base = Session.create(id)
  owner = { id, options: {}, session: Session.create(id, [], { ...base.header, cwd: workspace }), inbox: emptyInbox(),
    status: 'idle', ctx: scope.ctx, followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(owner)
  const jobsFiber = ctx.plugin((child: Context) => { jobs = new CapturingJobs(child) })
  await jobsFiber.await()
  disposeJobs = async () => { await jobsFiber.dispose() }
  registerManagedValidators(ctx, { profiles: { local: p } })
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(ToolRuntime).await()
  registerManagedTools(ctx, { profiles: { local: p } })
  vi.mocked(resolveModel).mockReset().mockResolvedValue({ environment: {}, redact: text => text, capability: 'available' })
  request = { requestId: 'request-one', signal: new AbortController().signal, deadline: Date.now() + 1000,
    attempt: { root: join(workspace, '.devflow'), id: DevflowCardId('0001-check'), from: 'testing', to: 'done',
      expectedRevision: 12, at: 'now', by: { kind: 'agent', session: id } } }
  manifest = { version: 1, runId: 'fresh-run', card: '0001-check', status: 'passed', startedAt: 'now', endedAt: 'later',
    identity: { workspace, commit: 'commit', workspaceSha256: 'hash', suiteSha256: p.suiteSha256 ?? '', buildId: 'build',
      buildVerified: true, model: 'vision', midscene: '1.12.6', playwright: '1.63.0' },
    counts: { cases: 1, completedCases: 1, assertions: 1, passedAssertions: 1, steps: 1, completedSteps: 1 },
    results: [{ id: 'one', status: 'passed', completedSteps: 1, passedAssertions: 1, report: 'one.html', screenshot: 'one.png' }],
    cleanup: 'confirmed', usage: 'unavailable', reports: { markdown: 'report.md', html: 'report.html', results: 'results.json', baseUrl: 'file:///' } }
  vi.mocked(workspaceIdentity).mockReset().mockResolvedValue({ commit: 'commit', workspaceSha256: 'hash' })
  await writeFile(p.deploymentRecord ?? '', JSON.stringify({ version: 1, commit: 'commit', workspaceSha256: 'hash', buildId: 'build' }), { mode: 0o600 })
  await mkdir(join(p.output, manifest.runId), { recursive: true })
  vi.mocked(runAcceptance).mockReset().mockImplementation(async (options) => { options.onProgress?.('step one'); return structuredClone(manifest) })
})
afterEach(async () => {
  vi.unstubAllEnvs(); await ctx.fiber.dispose(); validators.clear(); await rm(dir, { recursive: true, force: true })
})

async function run(): Promise<Awaited<ReturnType<GateValidator>>> {
  const validator = validators.get('midscene:local')
  if (!validator) throw new Error('validator missing')
  return validator(request)
}

it('runs fresh owner jobs and persists both attempt and run evidence before allowing', async () => {
  const first = await run()
  expect(first.allowed).toBe(true)
  request = { ...request, requestId: 'request-two' }
  expect((await run()).allowed).toBe(true)
  expect(runAcceptance).toHaveBeenCalledTimes(2)
  expect(jobs.starts.map(start => start.owner)).toEqual([owner, owner])
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'completed' })
  const record = await readFile(join(p.output, 'fresh-run', 'gate.json'), 'utf8')
  expect(record).toContain('request-two')
  expect(record).toContain('midscene-2')
  expect(record).toContain('"expectedRevision": 12')
  expect(await readFile(join(p.output, 'gates', 'request-one.json'), 'utf8')).toContain('fresh-run')
  expect(jobs.hooks[0]?.readOutput?.()).toContain('step one')
  expect(jobs.hooks[0]?.readOutput?.()).toBe('')
})

it.each(['human', 'unknown-session', 'foreign-root'] as const)('refuses unowned or wrong-scope gate: %s', async (mode) => {
  if (mode === 'human') request = { ...request, attempt: { ...request.attempt, by: { kind: 'human' } } }
  if (mode === 'unknown-session') request = { ...request, attempt: { ...request.attempt, by: { kind: 'agent', session: 'missing' } } }
  if (mode === 'foreign-root') request = { ...request, attempt: { ...request.attempt, root: join(dir, '.devflow') } }
  expect((await run()).allowed).toBe(false)
  expect(jobs.starts).toHaveLength(0)
})

it.each(['failed', 'cleanup', 'build', 'suite', 'zero', 'partial', 'screenshot'] as const)('refuses incomplete acceptance: %s', async (mode) => {
  if (mode === 'failed') manifest.status = 'assertion-failed'
  if (mode === 'cleanup') manifest.cleanup = 'unknown'
  if (mode === 'build') manifest.identity.buildVerified = false
  if (mode === 'suite') manifest.identity.suiteSha256 = 'changed'
  if (mode === 'zero') manifest.counts.assertions = 0
  if (mode === 'partial') manifest.counts.completedSteps = 0
  if (mode === 'screenshot') manifest.results = [{ id: 'one', status: 'passed', completedSteps: 1, passedAssertions: 1 }]
  expect((await run()).allowed).toBe(false)
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'failed' })
  expect(await readFile(join(p.output, 'fresh-run', 'gate.json'), 'utf8')).toContain('"allowed": false')
})

it('records safe failure evidence when execution throws before a manifest exists', async () => {
  vi.mocked(runAcceptance).mockRejectedValueOnce(new Error('secret-credential'))
  const result = await run()
  expect(result.allowed).toBe(false)
  const text = await readFile(join(p.output, 'gates', 'request-one.json'), 'utf8')
  expect(text).toContain('unavailable')
  expect(text).not.toContain('secret-credential')
})

it('job cancellation forwards the signal and waits for cleanup before settling', async () => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  let cleanup!: () => void
  const cleanupDone = new Promise<void>((resolve) => { cleanup = resolve })
  vi.mocked(runAcceptance).mockImplementationOnce(async (options) => {
    started()
    await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }) })
    await cleanupDone
    return { ...manifest, status: 'cancelled' }
  })
  let finished = false
  const pending = run().then((result) => { finished = true; return result })
  await ready
  jobs.hooks[0]?.cancel()
  await Promise.resolve()
  expect(finished).toBe(false)
  cleanup()
  expect((await pending).allowed).toBe(false)
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'killed' })
})


async function call(name: string, args: object = {}, agent?: Agent): Promise<{ error: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({ name, arguments: args,
    callId: ('test-' + name) as ToolExecutionInput['callId'], signal: new AbortController().signal,
    ...agent ? { agent } : {},
  })
  return { error: result.isError, text: result.content.map(block => block.type === 'text' ? block.text : '').join('') }
}

it('doctor requires exactly one session profile and reports model/login/gate readiness', async () => {
  expect((await call('midscene_doctor')).error).toBe(true)
  expect((await call('midscene_doctor', { profile: 'missing' }, owner)).error).toBe(true)
  const configured = await call('midscene_doctor', {}, owner)
  expect(configured.error).not.toBe(true)
  expect(configured.text).toContain('model: available')
  expect(configured.text).toContain('no snapshot')
  p.storageState = '/private/state.json'
  expect((await call('midscene_doctor', { profile: 'local' }, owner)).text).toContain('snapshot configured')
  delete p.storageState
  p.browserMode = 'bridge'
  delete p.suite
  expect((await call('midscene_doctor', {}, owner)).text).toContain('borrowed browser')
  expect((await call('midscene_doctor', {}, owner)).text).toContain('missing approved')
  vi.mocked(resolveModel).mockRejectedValueOnce(new Error('MODEL_UNAVAILABLE'))
  expect((await call('midscene_doctor', {}, owner)).text).toContain('MODEL_UNAVAILABLE')
  vi.mocked(resolveModel).mockRejectedValueOnce('unknown')
  expect((await call('midscene_doctor', {}, owner)).text).toContain('MODEL_UNAVAILABLE')
})

it('browser starts visible exploration jobs with authenticated artifact links', async () => {
  vi.mocked(exploreBrowser).mockResolvedValue({ runId: 'r', status: 'observed', purpose: 'exploration', workspace: p.workspace,
    directory: p.output, cleanup: 'confirmed', output: 'image', artifacts: ['screenshots/a.png'] })
  const result = await call('midscene_browser', {}, owner)
  expect(result.text).toContain('Started midscene-1')
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'completed' })
  expect(jobs.hooks[0]?.readOutput?.()).toContain('/devflow/reports/gate-owner/r/screenshots/a.png')
  expect(jobs.hooks[0]?.readOutput?.()).toBe('')
})

it.each(['infrastructure-error', 'assertion-failed', 'cancelled'] as const)('browser failed exploration ends the job as failed: %s', async (status) => {
  vi.mocked(exploreBrowser).mockResolvedValue({ runId: 'r', status, purpose: 'exploration', workspace: p.workspace,
    directory: p.output, cleanup: 'confirmed', output: '', artifacts: [] })
  expect((await call('midscene_browser', {}, owner)).error).not.toBe(true)
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'failed' })
})

it('cancelled browser jobs settle only when their producer returns', async () => {
  let finish!: () => void
  const paused = new Promise<void>((resolve) => { finish = resolve })
  vi.mocked(exploreBrowser).mockImplementation(async () => {
    await paused
    return { runId: 'r', status: 'observed', purpose: 'exploration', workspace: p.workspace, directory: p.output,
      cleanup: 'confirmed', output: '', artifacts: [] }
  })
  await call('midscene_browser', {}, owner)
  jobs.hooks[0]?.cancel()
  finish()
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'killed' })
})

it('non-Error producer rejection is a safe failed job', async () => {
  vi.mocked(exploreBrowser).mockRejectedValue('unknown')
  await call('midscene_browser', {}, owner)
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'failed', output: 'Midscene failed' })
})

it('inspect reads formal records and marks unfinished exploration unknown', async () => {
  const runId = '12345678-1234-1234-1234-123456789012'
  await mkdir(join(p.output, runId))
  vi.mocked(inspectRun).mockResolvedValue({ status: 'passed', reportAvailable: true, manifest: { identity: { workspace: p.workspace } } })
  expect((await call('midscene_inspect', { runId }, owner)).text).toContain('test-report.md')
  await writeFile(join(p.output, runId, 'exploration.json'), JSON.stringify({ purpose: 'exploration', workspace: p.workspace, runId, status: 'running' }))
  expect((await call('midscene_inspect', { runId }, owner)).text).toContain('unknown')
  await writeFile(join(p.output, runId, 'exploration.json'), JSON.stringify({ purpose: 'exploration', workspace: p.workspace, runId, status: 'observed' }))
  expect((await call('midscene_inspect', { runId }, owner)).text).toContain('observed')
  await writeFile(join(p.output, runId, 'exploration.json'), '{}')
  expect((await call('midscene_inspect', { runId }, owner)).error).toBe(true)
  await writeFile(join(p.output, runId, 'exploration.json'), '{')
  expect((await call('midscene_inspect', { runId }, owner)).error).toBe(true)
  expect((await call('midscene_inspect', { runId: '../escape' }, owner)).error).toBe(true)
})


it('formal tool requires the store and runs an existing card in its session workspace', async () => {
  expect((await call('midscene_run', { card: '0001-check' }, owner)).error).toBe(true)
  await ctx.plugin(FilesystemDevflowStore, { root: join(p.workspace, '.devflow') }).await()
  const cardDir = join(p.workspace, '.devflow', 'tasks', '0001-check')
  await mkdir(cardDir, { recursive: true })
  await writeFile(join(cardDir, 'card.md'), '---\ntitle: acceptance\n---\n')
  await writeFile(join(cardDir, 'journal.jsonl'), JSON.stringify({ rev: 1, at: 'now', type: 'created', by: { kind: 'human' } }) + '\n')
  expect((await call('midscene_run', { card: '0001-check' }, owner)).text).toContain('Started midscene-1')
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'completed' })
  expect(jobs.hooks[0]?.readOutput?.()).toContain('/devflow/reports/gate-owner/fresh-run/report.md')
  manifest.status = 'assertion-failed'
  await call('midscene_run', { card: '0001-check' }, owner)
  expect(await jobs.hooks[1]?.done).toMatchObject({ status: 'failed' })
})

it('formal execution binds approved inputs and passes optional private browser inputs', async () => {
  const noop = (): void => {}
  await expect(runManaged(ctx, { ...p, suite: '' }, '0001-check', new AbortController().signal, noop)).rejects.toThrow('ACCEPTANCE_NOT_CONFIGURED')
  await expect(runManaged(ctx, { ...p, suiteSha256: 'changed' }, '0001-check', new AbortController().signal, noop)).rejects.toThrow('INPUT_CHANGED')
  await writeFile(join(dir, 'outside.json'), '{}')
  await expect(runManaged(ctx, { ...p, suite: join(dir, 'outside.json') }, '0001-check', new AbortController().signal, noop)).rejects.toThrow('inside its workspace')
  await runManaged(ctx, { ...p, storageState: '/private/state', executablePath: '/chrome' }, '0001-check', new AbortController().signal, noop)
  expect(vi.mocked(runAcceptance).mock.calls.at(-1)?.[0]).toMatchObject({ storageState: '/private/state', executablePath: '/chrome' })
})

it('scope mismatches and unavailable engines are explicit', async () => {
  const isolated = new Context()
  registerManagedValidators(isolated, { profiles: { local: p } })
  await isolated.fiber.dispose()
  const other = { ...owner, session: Session.create(owner.id, [], { ...owner.session.header, cwd: dir }) }
  expect((await call('midscene_doctor', {}, other)).error).toBe(true)
  const header = { ...owner.session.header, cwd: dir }
  vi.spyOn(ctx.agents, 'get').mockReturnValue({ ...owner, session: Session.create(owner.id, [], header) })
  expect((await run()).allowed).toBe(false)
})

it('validator honors cancellation before execution and elapsed deadlines', async () => {
  request = { ...request, signal: AbortSignal.abort() }
  expect((await run()).allowed).toBe(false)
  request = { ...request, signal: new AbortController().signal, deadline: 0 }
  expect((await run()).allowed).toBe(false)
  expect(runAcceptance).not.toHaveBeenCalled()
})

it('cancelling during model preflight records cancelled instead of leaking transport errors', async () => {
  let began!: () => void
  const ready = new Promise<void>((resolve) => { began = resolve })
  vi.mocked(resolveModel).mockImplementationOnce(async (_ctx, _profile, signal) => {
    began()
    await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }) })
    throw new Error('secret')
  })
  const pending = run()
  await ready
  jobs.hooks[0]?.cancel()
  expect((await pending).allowed).toBe(false)
  expect(await readFile(join(p.output, 'gates', 'request-one.json'), 'utf8')).toContain('cancelled')
})

it('unwritable gate evidence prevents allowance', async () => {
  await writeFile(join(p.output, 'gates'), 'occupied')
  expect((await run()).allowed).toBe(false)
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'failed' })
})

it('inspect refuses a symlink escaping the configured report root', async () => {
  const runId = '12345678-1234-1234-1234-123456789012'
  await symlink(dir, join(p.output, runId))
  expect((await call('midscene_inspect', { runId }, owner)).error).toBe(true)
})

it('cancelled throwing exploration settles killed, and missing jobs never starts a browser', async () => {
  let release!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  vi.mocked(exploreBrowser).mockImplementationOnce(async () => { await paused; throw new Error('cancelled') })
  await call('midscene_browser', {}, owner)
  jobs.hooks[0]?.cancel()
  release()
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'killed' })
  await disposeJobs()
  expect((await call('midscene_browser', {}, owner)).error).toBe(true)
})


it('doctor marks disabled gate engine unavailable', async () => {
  removeValidators()
  expect((await call('midscene_doctor', {}, owner)).text).toContain('completion checks: service unavailable')
})

it('normalizes opaque acceptance failures before they reach job output', async () => {
  vi.mocked(runAcceptance).mockRejectedValueOnce('opaque')
  await expect(runManaged(ctx, p, '0001-check', new AbortController().signal, () => {})).rejects.toThrow('Midscene failed')
})

it('a producer result that fails during formatting cannot escape job settlement', async () => {
  vi.mocked(exploreBrowser).mockResolvedValueOnce({
    runId: 'r', get status(): never { throw 'opaque result failure' }, purpose: 'exploration', workspace: p.workspace,
    directory: p.output, cleanup: 'confirmed', output: '', artifacts: [],
  })
  await call('midscene_browser', {}, owner)
  expect(await jobs.hooks[0]?.done).toMatchObject({ status: 'failed', output: 'Midscene failed' })
})


it('report links use the explicit Harness host or local files, never the target application origin', async () => {
  vi.mocked(exploreBrowser).mockResolvedValue({ runId: 'r', status: 'observed', purpose: 'exploration', workspace: p.workspace,
    directory: p.output, cleanup: 'confirmed', output: '', artifacts: ['screenshots/a.png'] })
  await call('midscene_browser', {}, owner)
  await jobs.hooks[0]?.done
  expect(jobs.hooks[0]?.readOutput?.()).toContain('http://localhost:3082/devflow/reports/')
  delete p.reportBaseUrl
  p.targetUrl = 'https://unrelated-application.test'
  await call('midscene_browser', {}, owner)
  await jobs.hooks[1]?.done
  const output = jobs.hooks[1]?.readOutput?.()
  expect(output).toContain('file:')
  expect(output).not.toContain('unrelated-application.test')
})


it('final freshness rechecks workspace, approved suite, receipt and cancellation without rerunning the browser', async () => {
  const result = await run()
  if (!result.allowed || !result.revalidate) throw new Error('Expected fresh verifier')
  expect(await result.revalidate()).toBe(true)
  const accepted = await vi.mocked(runAcceptance).mock.results[0]?.value as RunManifest
  expect(vi.mocked(recheckAcceptance).mock.calls.at(-1)?.[1]).toBe(accepted)
  vi.mocked(recheckAcceptance).mockRejectedValueOnce(new Error('Build instance changed before commit'))
  await expect(result.revalidate()).rejects.toThrow('Build instance changed')
  const suite = p.suite
  delete p.suite
  expect(await result.revalidate()).toBe(false)
  if (suite !== undefined) p.suite = suite
  vi.mocked(workspaceIdentity).mockResolvedValueOnce({ commit: 'changed', workspaceSha256: 'hash' })
  expect(await result.revalidate()).toBe(false)
  await writeFile(join(p.workspace, 'suite.json'), 'changed')
  expect(await result.revalidate()).toBe(false)
  await writeFile(join(p.workspace, 'suite.json'), SUITE)
  await writeFile(p.deploymentRecord ?? '', '{}')
  await expect(result.revalidate()).rejects.toThrow('Deployment receipt')
  jobs.hooks[0]?.cancel()
  expect(await result.revalidate()).toBe(false)
  expect(runAcceptance).toHaveBeenCalledTimes(1)
})


it('shared output directories do not authorize inspecting a different workspace run', async () => {
  const runId = '12345678-1234-1234-1234-123456789012'
  await mkdir(join(p.output, runId))
  vi.mocked(inspectRun).mockResolvedValueOnce({ status: 'passed', reportAvailable: true, manifest: { identity: { workspace: dir } } })
  expect((await call('midscene_inspect', { runId }, owner)).error).toBe(true)
  await writeFile(join(p.output, runId, 'exploration.json'), JSON.stringify({ purpose: 'exploration', workspace: dir, runId, status: 'passed' }))
  expect((await call('midscene_inspect', { runId }, owner)).error).toBe(true)
})


it('recovery accepts only a configured run and keeps interrupted recovery separate from acceptance', async () => {
  const runId = '12345678-1234-1234-1234-123456789012'
  await mkdir(join(p.output, runId))
  vi.mocked(recoverExploration).mockResolvedValueOnce({ runId, status: 'interrupted', cleanup: 'confirmed' })
  expect((await call('midscene_recover', { runId }, owner)).text).toContain('interrupted')
  expect(recoverExploration).toHaveBeenCalledWith(join(p.output, runId), p.workspace, p.cleanupTimeoutMs)
  expect((await call('midscene_recover', { runId: '../outside' }, owner)).error).toBe(true)
  expect(runAcceptance).not.toHaveBeenCalled()
  expect((await call('midscene_recover', { runId })).error).toBe(true)
})


it('formal suite target must share the configured origin while navigation paths remain free', async () => {
  await expect(runManaged(ctx, { ...p, targetUrl: 'http://localhost:9999' }, '0001-check', new AbortController().signal, () => {})).rejects.toThrow('TARGET_MISMATCH')
  expect(runAcceptance).not.toHaveBeenCalled()
  await runManaged(ctx, { ...p, targetUrl: 'http://localhost:3000/different-page' }, '0001-check', new AbortController().signal, () => {})
  expect(runAcceptance).toHaveBeenCalledTimes(1)
})

it('doctor keeps its result usable when diagnostic persistence fails', async () => {
  p.output = join(p.workspace, 'unsafe-output')
  expect((await call('midscene_doctor', {}, owner)).text).toContain('diagnostic persistence: unavailable')
})

async function projectMode(): Promise<AcceptanceProfile> {
  vi.stubEnv('DSH_HOME', join(dir, 'host'))
  await writeSettings(p.workspace, { targetUrl: p.targetUrl, model: { provider: 'existing', model: 'gpt-5', family: 'gpt-5' },
    suites: { '0001-check': { suite: 'suite.json', suiteSha256: sha256(SUITE), buildId: 'build' } } })
  return resolveProjectProfile(owner, {}, '0001-check')
}

it('runs project browser jobs with DSH transport and releases it after success and failure', async () => {
  const dynamic = await projectMode()
  const dispose = vi.fn(async () => {})
  vi.mocked(startDshModelBridge).mockResolvedValue({ environment: {}, redact: text => text, capability: 'available', dispose })
  vi.mocked(exploreBrowser).mockResolvedValue({ runId: 'observed', status: 'observed', purpose: 'exploration', workspace: p.workspace, directory: dynamic.output, cleanup: 'confirmed', output: '', artifacts: ['page.png'] })
  expect((await call('midscene_doctor', { profile: 'project' }, owner)).text).toContain('model: available')
  expect(checkDshModel).toHaveBeenCalled()
  expect((await call('midscene_browser', { profile: 'project' }, owner)).error).not.toBe(true)
  const outcome = await jobs.hooks.at(-1)?.done
  expect(outcome).toMatchObject({ status: 'completed' })
  expect(JSON.stringify(outcome)).toContain('/devflow/reports/')
  expect(dispose).toHaveBeenCalledTimes(1)
  vi.mocked(exploreBrowser).mockRejectedValueOnce(new Error('transport failed'))
  await call('midscene_browser', { profile: 'project' }, owner)
  expect(await jobs.hooks.at(-1)?.done).toMatchObject({ status: 'failed' })
  expect(dispose).toHaveBeenCalledTimes(2)
  vi.unstubAllEnvs()
})

it('dynamic project validator resolves its task binding and rejects changed settings at final recheck', async () => {
  const dynamic = await projectMode()
  manifest.identity.model = dynamic.model
  await mkdir(join(dynamic.output, manifest.runId), { recursive: true })
  const validator = validators.get('midscene:project')
  if (!validator) throw new Error('missing project validator')
  const verdict = await validator(request)
  expect(verdict.allowed).toBe(true)
  expect(startDshModelBridge).toHaveBeenCalled()
  if (verdict.allowed) {
    await writeSettings(p.workspace, { targetUrl: 'http://localhost:9999', model: { provider: 'existing', model: 'gpt-5' } })
    expect(await verdict.revalidate?.()).toBe(false)
  }
  vi.unstubAllEnvs()
})

it('attaches project acceptance reports through the real Devflow store and reports revision conflicts', async () => {
  const dynamic = await projectMode()
  await ctx.plugin(FilesystemDevflowStore, { root: join(p.workspace, '.devflow') }).await()
  const cardDir = join(p.workspace, '.devflow', 'tasks', '0001-check')
  await mkdir(cardDir, { recursive: true })
  await writeFile(join(cardDir, 'card.md'), '---\ntitle: acceptance\n---\n')
  await writeFile(join(cardDir, 'journal.jsonl'), JSON.stringify({ rev: 1, at: 'now', type: 'created', by: { kind: 'human' } }) + '\n')
  await mkdir(join(dynamic.output, manifest.runId), { recursive: true })
  await writeFile(join(dynamic.output, manifest.runId, manifest.reports.markdown), '# Acceptance\n\nActual report\n')
  expect((await call('midscene_run', { card: '0001-check' }, owner)).error).not.toBe(true)
  expect(await jobs.hooks.at(-1)?.done).toMatchObject({ status: 'completed' })
  expect((await ctx.devflow.history(DevflowCardId('0001-check'))).at(-1)).toMatchObject({ type: 'artifact', kind: 'test-report' })
  vi.spyOn(ctx.devflow, 'attachArtifact').mockResolvedValueOnce({ ok: false, code: 'revision-mismatch', message: 'changed' })
  await call('midscene_run', { card: '0001-check' }, owner)
  const failed = await jobs.hooks.at(-1)?.done
  expect(failed?.status).toBe('failed')
  expect(JSON.stringify(failed)).toContain('REPORT_ATTACHMENT_FAILED')
})

it('project selection ignores deleted unrelated profiles and history needs neither target nor model', async () => {
  const missing = { ...p, workspace: join(dir, 'missing') }
  const { selectProfile } = await import('../src/managed.ts')
  vi.stubEnv('DSH_HOME', join(dir, 'host'))
  const exec = { agent: owner, signal: new AbortController().signal } as import('@deepseek-ai/dsh-tools').ToolRunContext
  expect((await selectProfile({ profiles: { stale: missing } }, exec, undefined, { history: true }))[0]).toBe('project')
  expect((await selectProfile({ profiles: { stale: missing } }, exec, 'project', { history: true }))[0]).toBe('project')
  await expect(selectProfile({ profiles: { stale: missing } }, exec, 'stale')).rejects.toThrow()
  await writeFile(join(dir, 'not-directory'), '')
  expect((await selectProfile({ profiles: { stale: { ...missing, workspace: join(dir, 'not-directory', 'child') } } }, exec, undefined, { history: true }))[0]).toBe('project')
  const runId = '12345678-1234-1234-1234-123456789012'
  const { projectHistoryProfile } = await import('../src/project-runtime.ts')
  const history = await projectHistoryProfile(owner)
  await mkdir(join(history.output, runId))
  await writeFile(join(history.output, runId, 'exploration.json'), JSON.stringify({ purpose: 'exploration', workspace: p.workspace, runId, status: 'observed' }))
  expect((await call('midscene_inspect', { profile: 'project', runId }, owner)).text).toContain('observed')
})

it('DSH formal execution refuses a missing provider before starting a bridge', async () => {
  await expect(runManaged(ctx, { ...p, modelSource: 'dsh' }, '0001-check', new AbortController().signal, () => {})).rejects.toThrow('DSH provider required')
})

it('rechecks project choices after the final deployment probe', async () => {
  const dynamic = await projectMode()
  manifest.identity.model = dynamic.model
  await mkdir(join(dynamic.output, manifest.runId), { recursive: true })
  await writeFile(dynamic.deploymentRecord ?? '', JSON.stringify({ version: 1, commit: 'commit', workspaceSha256: 'hash', buildId: 'build' }), { mode: 0o600 })
  const validator = validators.get('midscene:project')
  if (!validator) throw new Error('missing validator')
  const result = await validator(request)
  expect(result.allowed).toBe(true)
  if (result.allowed) {
    vi.mocked(recheckAcceptance).mockImplementationOnce(async () => { await writeSettings(p.workspace, { targetUrl: 'http://localhost:9999' }) })
    expect(await result.revalidate?.()).toBe(false)
  }
})

it('archives historical runs with the actual Devflow attachment API and surfaces registration conflicts', async () => {
  expect((await call('midscene_archive', { card: '0001-check', runId: 'r' }, owner)).text).toContain('Devflow unavailable')
  await ctx.plugin(FilesystemDevflowStore, { root: join(p.workspace, '.devflow') }).await()
  const cardDir = join(p.workspace, '.devflow/tasks/0001-check')
  await mkdir(cardDir, { recursive: true })
  await writeFile(join(cardDir, 'card.md'), '---\ntitle: reports\n---\n')
  await writeFile(join(cardDir, 'journal.jsonl'), JSON.stringify({ rev: 1, at: 'now', type: 'created', by: { kind: 'human' } }) + '\n')
  expect((await call('midscene_archive', { card: '0001-check', runId: 'r' }, owner)).text).toContain('cardReport')
  expect((await ctx.devflow.history(DevflowCardId('0001-check'))).at(-1)).toMatchObject({ type: 'artifact', kind: 'test-report' })
  vi.spyOn(ctx.devflow, 'attachArtifact').mockResolvedValueOnce({ ok: false, code: 'revision-mismatch', message: 'changed' })
  expect((await call('midscene_archive', { card: '0001-check', runId: 'r' }, owner)).text).toContain('REPORT_ATTACHMENT_FAILED')
})
it('attaches an exploration to its explicit card even when the visual assertion fails', async () => {
  expect((await call('midscene_browser', { card: '0001-check' }, owner)).text).toContain('Devflow unavailable')
  await ctx.plugin(FilesystemDevflowStore, { root: join(p.workspace, '.devflow') }).await()
  const cardDir = join(p.workspace, '.devflow/tasks/0001-check')
  await mkdir(cardDir, { recursive: true })
  await writeFile(join(cardDir, 'card.md'), '---\ntitle: reports\n---\n')
  await writeFile(join(cardDir, 'journal.jsonl'), JSON.stringify({ rev: 1, at: 'now', type: 'created', by: { kind: 'human' } }) + '\n')
  vi.mocked(exploreBrowser).mockResolvedValue({ runId: 'r', status: 'assertion-failed', purpose: 'exploration', workspace: p.workspace,
    directory: p.output, cleanup: 'confirmed', output: '', artifacts: [] })
  await call('midscene_browser', { card: '0001-check' }, owner)
  const outcome = await jobs.hooks.at(-1)?.done
  expect(outcome?.status).toBe('failed')
  expect(JSON.stringify(outcome)).toContain('cardReport')
  expect((await ctx.devflow.history(DevflowCardId('0001-check'))).at(-1)).toMatchObject({ type: 'artifact', kind: 'test-report' })
  vi.spyOn(ctx.devflow, 'attachArtifact').mockResolvedValueOnce({ ok: false, code: 'revision-mismatch', message: 'changed' })
  await call('midscene_browser', { card: '0001-check' }, owner)
  expect(JSON.stringify(await jobs.hooks.at(-1)?.done)).toContain('REPORT_ATTACHMENT_FAILED')
})

it('reports a path-registration conflict before claiming the HTML is visible in the card', async () => {
  await ctx.plugin(FilesystemDevflowStore, { root: join(p.workspace, '.devflow') }).await()
  const cardDir = join(p.workspace, '.devflow/tasks/0001-check')
  await mkdir(cardDir, { recursive: true })
  await writeFile(join(cardDir, 'card.md'), '---\ntitle: reports\n---\n')
  await writeFile(join(cardDir, 'journal.jsonl'), JSON.stringify({ rev: 1, at: 'now', type: 'created', by: { kind: 'human' } }) + '\n')
  vi.spyOn(ctx.devflow, 'attachArtifact').mockResolvedValueOnce({ ok: false, code: 'revision-mismatch', message: 'changed' })
  expect((await call('midscene_archive', { card: '0001-check', runId: 'r' }, owner)).text).toContain('REPORT_ATTACHMENT_FAILED')
})

it('doctor resolves the selected card and does not misdiagnose an unselected project', async () => {
  await projectMode()
  try {
    const unselected = await call('midscene_doctor', { profile: 'project' }, owner)
    expect(unselected.text).toContain('formal acceptance: not checked')
    expect(unselected.text).not.toContain('preparation required')
    const selected = await call('midscene_doctor', { profile: 'project', card: '0001-check' }, owner)
    expect(selected.error, selected.text).toBe(false)
    expect(selected.text).toContain('formal acceptance: configured')
    expect(selected.text).toContain('file validity, deployment identity and execution checks pending')
    expect(selected.text).toContain('metadata check only')
    const unbound = await call('midscene_doctor', { profile: 'project', card: '0002-other' }, owner)
    expect(unbound.text).toContain('preparation required; missing approved suite, suite approval hash, build identity, deployment receipt reference')
    expect(unbound.text).toContain('midscene_bind')
    expect(unbound.text).toContain('never substitutes')
  } finally { vi.unstubAllEnvs() }
})
