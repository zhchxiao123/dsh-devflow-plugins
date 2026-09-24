/* oxlint-disable @stylistic/max-len */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { JevError, JevRuntime, type JevRequest, type JevResponse } from '@zhchxiao123/dsh-jev'
import { afterEach, expect, it, vi } from 'vitest'
import { DevflowJev, apply } from '../src/index.ts'
import { emptyInbox } from '../../../tests/agent-double.ts'
class Provider extends JevRuntime {
  calls = 0
  script: (signal?: AbortSignal) => Promise<JevResponse> = () => Promise.resolve({ answers: {} })
  protected perform(_request: JevRequest, signal?: AbortSignal): Promise<JevResponse> { this.calls++; return this.script(signal) }
}
let context: Context | undefined; let directory: string | undefined
async function boot() {
  directory = await mkdtemp(join(tmpdir(), 'jev-boundaries-')); const root = join(directory, '.devflow')
  const ctx = new Context(); context = ctx
  await ctx.plugin(FilesystemDevflowStore, { root }); await ctx.plugin(Provider); await ctx.plugin(DevflowJev)
  const provider = ctx.jev; if (!(provider instanceof Provider)) throw new Error('missing fixture provider')
  return { ctx, root, provider }
}
async function owner(ctx: Context, root: string) {
  await ctx.plugin(Sessions); await ctx.plugin(AgentRegistry); await ctx.plugin(Jobs)
  ctx.effect(() => ctx.jobs.attachController('boundary-test'))
  const session = ctx.sessions.create(SessionId('owner'), { meta: { cwd: root } }); const scope = ctx.plugin(() => {})
  const agent: Agent = { id: session.id, session, ctx: scope.ctx, options: {}, inbox: emptyInbox(), status: 'idle', followup() {}, steer() {}, inject() {}, send() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(agent); return agent
}
afterEach(async () => { vi.restoreAllMocks(); await context?.fiber.dispose(); if (directory !== undefined) await rm(directory, { recursive: true, force: true }); context = undefined; directory = undefined })
it('rejects invalid policy budgets before mounting services', () => {
  const ctx = new Context(); context = ctx
  for (const n of [-1, Infinity, NaN]) expect(() => { apply(ctx, { policy: { maximumRisk: n } }) }).toThrow('non-negative finite')
  expect(() => { apply(ctx, { policy: { choiceConfidenceFloor: 2 } }) }).toThrow('at most 1')
  expect(() => { apply(ctx, { policy: { scoreConfidenceFloor: 2 } }) }).toThrow('at most 1')
  // The rubric v3 field name: a stale deployment override fails loud instead of silently gating nothing.
  expect(() => { apply(ctx, { policy: { confidenceFloor: 0.5 } as never }) }).toThrow('not a policy field')
})
it('validates public assessment inputs and rejects invalid proposal ids', async () => {
  const { ctx, root } = await boot()
  await expect(ctx.devflowJev.assess(root, { target: 'request', title: 'x', body: 'x', assessmentKind: 'invalid' as 'intake' })).rejects.toThrow('invalid assessment kind')
  await expect(ctx.devflowJev.decideJudgement(root, '../bad', 'reject', { kind: 'human' })).rejects.toThrow('invalid evaluation id')
  await expect(ctx.devflowJev.read(root, '../bad')).rejects.toThrow('invalid evaluation id')
  const evaluated = await ctx.devflowJev.assess(root, { target: 'request', title: 'Request', body: 'Evidence', assessmentKind: 'planning' })
  expect(evaluated.assessmentKind).toBe('planning'); expect(evaluated.providerModel).toBeUndefined()
  await expect(ctx.devflowJev.accept(root, evaluated.id, { kind: 'human' })).rejects.toThrow('not an actionable proposal')
  const rejected = await ctx.devflowJev.decideJudgement(root, evaluated.id, 'reject', { kind: 'human' })
  expect(rejected.status).toBe('rejected'); expect(await ctx.devflowJev.reject(root, evaluated.id)).toEqual(rejected)
})
it('keeps corrupt evaluation files visible as errors and distinguishes absent storage', async () => {
  const { ctx, root } = await boot(); expect(await ctx.devflowJev.list(root)).toEqual([])
  const path = join(root, 'judgements', 'evaluations'); await mkdir(path, { recursive: true })
  for (const value of [null, 1, {}]) { await writeFile(join(path, 'aaa.json'), JSON.stringify(value)); await expect(ctx.devflowJev.read(root, 'aaa')).rejects.toThrow('invalid evaluation') }
  await rm(path, { recursive: true }); await writeFile(path, 'not a directory')
  await expect(ctx.devflowJev.list(root)).rejects.toThrow()
})
it('rejects unavailable job infrastructure and invalid audit inputs', async () => {
  const { ctx, root } = await boot(); const agent = { } as Agent
  await expect(ctx.devflowJev.startAudit(root, { profile: 'invalid' }, agent)).rejects.toThrow('invalid audit profile')
  await expect(ctx.devflowJev.startAudit(root, {}, agent)).rejects.toThrow('JOBS_UNAVAILABLE')
  for (const maxCards of [0, 201, 1.5]) await expect(ctx.devflowJev.prepareAudit({ root, maxCards })).rejects.toThrow('integer from 1 to 200')
  const live = await owner(ctx, root); const plan = await ctx.devflowJev.prepareAudit({ root })
  await expect(ctx.devflowJev.controlAudit(root, plan.manifest.id, 'cancel', live)).rejects.toThrow('AUDIT_JOB_NOT_FOUND')
  const started = await ctx.devflowJev.startAudit(root, {}, live)
  expect(await ctx.jobs.wait(JobId(started.jobId), 2000, live)).toMatchObject({ status: 'completed' })
  await expect(ctx.devflowJev.resumeAudit(root, started.manifest.id)).rejects.toThrow('cannot resume from completed')
})
it('does not leave a job marked active when startup fails and reports job execution failures', async () => {
  const { ctx, root } = await boot(); const agent = await owner(ctx, root)
  const start = vi.spyOn(ctx.jobs, 'start').mockImplementationOnce(() => { throw new Error('controller stopped') })
  await expect(ctx.devflowJev.startAudit(root, {}, agent)).rejects.toThrow('controller stopped'); start.mockRestore()
  for (const failure of [new Error('disk lost'), 'disk lost']) {
    const list = ctx.devflow.list.bind(ctx.devflow)
    const execute = vi.spyOn(ctx.devflow, 'list').mockImplementationOnce(list).mockRejectedValueOnce(failure)
    const started = await ctx.devflowJev.startAudit(root, {}, agent)
    expect(await ctx.jobs.wait(JobId(started.jobId), 2000, agent)).toMatchObject({ status: 'failed' })
    execute.mockRestore()
  }
})
it('rebuilds a completed checkpoint when its evaluation file is missing', async () => {
  const { ctx, root } = await boot()
  const card = await ctx.devflow.create(ctx.devflow.resolveCreate({ title: 'Checkpoint', body: 'Acceptance', by: { kind: 'human' } })); if (!card.ok) throw new Error(card.message)
  const plan = await ctx.devflowJev.prepareAudit({ root, profile: 'risk' }); const first = await ctx.devflowJev.runAudit(root, plan.manifest.id)
  const check = first.state.results[0]; if (check === undefined) throw new Error('missing check')
  const folder = join(root, 'judgements', 'audits', plan.manifest.id)
  await rm(join(folder, 'evaluations', check.check.id + '.json'))
  const next = await ctx.devflowJev.runAudit(root, plan.manifest.id)
  expect(next.state.status).toBe('completed'); expect(next.state.completed).toBe(first.state.completed)
  expect(await readFile(join(folder, 'evaluations', check.check.id + '.json'), 'utf8')).toContain('Checkpoint')
})
it('propagates cancellation before or during a judgement without persisting an unavailable result', async () => {
  const { ctx, root, provider } = await boot(); const before = new AbortController(); before.abort()
  await expect(ctx.devflowJev.assessRequest({ root, title: 'Cancelled', body: 'Evidence' }, before.signal)).rejects.toMatchObject({ code: 'JEV_ABORTED' })
  expect(await ctx.devflowJev.list(root)).toEqual([])
  const during = new AbortController(); let entered = false
  provider.script = signal => new Promise((_resolve, reject) => { entered = true; signal?.addEventListener('abort', () => { reject(new JevError('cancelled', 'JEV_ABORTED')) }, { once: true }) })
  const pending = ctx.devflowJev.assessRequest({ root, title: 'Cancelled later', body: 'Evidence' }, during.signal)
  await expect.poll(() => entered).toBe(true); during.abort()
  await expect(pending).rejects.toMatchObject({ code: 'JEV_ABORTED' })
  expect(await ctx.devflowJev.list(root)).toEqual([])
})
it('persists real provider failures with card evidence and retries failed audit checkpoints', async () => {
  const { ctx, root, provider } = await boot()
  const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ title: 'Card', body: 'Evidence', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
  provider.script = () => Promise.reject(new JevError('credential missing', 'JEV_CREDENTIAL_MISSING'))
  expect(await ctx.devflowJev.assessCard({ root, cardId: created.card.id, assessmentKind: 'planning' })).toMatchObject({ status: 'unavailable', error: { code: 'JEV_CREDENTIAL_MISSING' }, evidence: { card: { id: created.card.id } } })
  const plan = await ctx.devflowJev.prepareAudit({ root, profile: 'risk' })
  const failed = await ctx.devflowJev.runAudit(root, plan.manifest.id)
  expect(failed.state.failed).toBe(plan.manifest.checks.length)
  expect(failed.state.results.every(value => value.error === 'credential missing')).toBe(true)
  provider.script = () => Promise.resolve({ answers: {} })
  const resumed = await ctx.devflowJev.resumeAudit(root, plan.manifest.id)
  expect(resumed.state).toMatchObject({ status: 'completed', failed: 0, completed: plan.manifest.checks.length })
})
it('retains model-less checkpoints and existing job attribution without reevaluating them', async () => {
  const { ctx, root, provider } = await boot()
  const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ title: 'Resume', body: 'Evidence', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
  const plan = await ctx.devflowJev.prepareAudit({ root, profile: 'risk' }); const first = await ctx.devflowJev.runAudit(root, plan.manifest.id)
  const path = join(root, 'judgements', 'audits', plan.manifest.id, 'state.json')
  await writeFile(path, JSON.stringify({ ...first.state, jobId: 'persisted-job' }))
  const calls = provider.calls; const next = await ctx.devflowJev.runAudit(root, plan.manifest.id)
  expect(provider.calls).toBe(calls); expect(next.state.results).toEqual(first.state.results); expect(next.state.jobId).toBe('persisted-job')
})
it('streams progress once and preserves a live running audit while listing', async () => {
  const { ctx, root, provider } = await boot(); const agent = await owner(ctx, root)
  const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ title: 'Progress', body: 'Evidence', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
  let release: ((value: JevResponse) => void) | undefined
  provider.script = () => new Promise((resolve) => { release = resolve })
  const started = await ctx.devflowJev.startAudit(root, { profile: 'risk' }, agent)
  await expect.poll(() => release !== undefined).toBe(true)
  expect(JSON.stringify(ctx.jobs.read(JobId(started.jobId), agent))).toContain(created.card.id)
  expect(JSON.stringify(ctx.jobs.read(JobId(started.jobId), agent))).not.toContain(created.card.id)
  expect((await ctx.devflowJev.listAudits(root))[0]?.state.status).toBe('running')
  provider.script = () => Promise.resolve({ answers: {} }); release?.({ answers: {} }); await ctx.jobs.wait(JobId(started.jobId), 2000, agent)
})
it('propagates card creation denial and refuses already-created corrupt proposals', async () => {
  const { ctx, root } = await boot(); const evaluation = await ctx.devflowJev.assessRequest({ root, title: 'Proposal', body: 'Evidence' })
  const path = join(root, 'judgements', 'evaluations', evaluation.id + '.json')
  await writeFile(path, JSON.stringify({ ...evaluation, decision: 'propose' }))
  const create = vi.spyOn(ctx.devflow, 'create').mockResolvedValueOnce({ ok: false, code: 'exists', message: 'creation denied' })
  await expect(ctx.devflowJev.accept(root, evaluation.id, { kind: 'human' })).rejects.toThrow('creation denied'); create.mockRestore()
  await writeFile(path, JSON.stringify({ ...evaluation, status: 'created' }))
  await expect(ctx.devflowJev.reject(root, evaluation.id)).rejects.toThrow('already created card')
})
it('recovers an orphaned audit with a durable interruption timestamp', async () => {
  const { ctx, root } = await boot(); const plan = await ctx.devflowJev.prepareAudit({ root })
  const recovered = await ctx.devflowJev.inspectAudit(root, plan.manifest.id)
  expect(recovered.state.status).toBe('interrupted'); expect(recovered.state.finishedAt).toEqual(expect.any(String))
  expect((await ctx.devflowJev.inspectAudit(root, plan.manifest.id)).state.finishedAt).toBe(recovered.state.finishedAt)
})
