/* oxlint-disable @stylistic/max-len */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { JevRuntime } from '../src/index.ts'
import type { JevRequest, JevResponse } from '../src/types.ts'
import type { JevRunSnapshot } from '../src/run-store.ts'
import * as Runs from '../src/runs-plugin.ts'
import { emptyInbox } from '../../../tests/agent-double.ts'

class Provider extends JevRuntime {
  protected perform(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    if (request.state === 'wait') return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true }) })
    return Promise.resolve({ answers: { answer: { type: 'noul', noul: 0.8 } } })
  }
}
let context: Context | undefined
let directory: string | undefined
afterEach(async () => { await context?.fiber.dispose(); if (directory !== undefined) await rm(directory, { recursive: true, force: true }); context = undefined; directory = undefined })
function owner(ctx: Context, id: string, cwd: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } }); const fiber = ctx.plugin(() => {})
  const agent: Agent = { id: session.id, session, ctx: fiber.ctx, options: {}, inbox: emptyInbox(), status: 'idle', followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(agent); return agent
}
async function boot() {
  directory = await mkdtemp(join(tmpdir(), 'jev-tools-')); const project = directory
  const ctx = new Context(); context = ctx
  await ctx.plugin(SystemPrompt); await ctx.plugin(Sessions); await ctx.plugin(AgentRegistry); await ctx.plugin(Tools); await ctx.plugin(Jobs); await ctx.plugin(Provider)
  ctx.effect(() => ctx.jobs.attachController('jev-tool-test'))
  const fiber = ctx.plugin(Runs); await fiber
  return { ctx, project, fiber, agent: owner(ctx, 'owner', project) }
}
function call(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({ name, arguments: args, ...(agent === undefined ? {} : { agent }), callId: ToolCallId('jev-tool-call'), signal: new AbortController().signal })
}
function value(result: Awaited<ReturnType<typeof call>>): unknown {
  return JSON.parse(result.content.map(block => 'text' in block ? block.text : '').join('\n')) as unknown
}

it('exposes three tools without Devflow and persists simple and advanced runs under the owning workspace', async () => {
  const { ctx, project, agent, fiber } = await boot()
  for (const name of ['jev_run', 'jev_list', 'jev_control']) expect(ctx.tools.get(name)).toBeDefined()
  for (const name of ['jev_start_run', 'jev_runs', 'jev_resume_run', 'jev_cancel_run']) expect(ctx.tools.get(name)).toBeUndefined()
  const result = await call(ctx, 'jev_run', { title: 'Checklist', evidence: 'Report', questions: ['Is it ready?', 'Is it tested?'] }, agent)
  expect(result.isError).toBeFalsy()
  const started = value(result) as JevRunSnapshot & { jobId: string }
  await expect(ctx.jobs.wait(JobId(started.jobId), 2000, agent)).resolves.toMatchObject({ status: 'completed' })
  expect(value(await call(ctx, 'jev_list', {}, agent))).toMatchObject([{ source: 'generic', id: started.definition.id, record: { definition: { scope: { title: 'Checklist' } }, state: { completed: 2 } } }])
  expect(value(await call(ctx, 'jev_list', { source: 'generic', id: started.definition.id }, agent))).toMatchObject([{ record: { state: { completed: 2 } } }])
  expect(await ctx.jevRuns.list(join(project, 'other'))).toEqual([])
  const advanced = await call(ctx, 'jev_run', { definitionJson: JSON.stringify({ ...started.definition, id: 'advanced' }) }, agent)
  expect(advanced.isError).toBeFalsy()
  await ctx.jobs.wait(JobId((value(advanced) as { jobId: string }).jobId), 2000, agent)
  expect((await call(ctx, 'jev_list', { id: 'advanced' }, agent)).isError).toBe(true)
  expect((await call(ctx, 'jev_run', { title: 'x' })).isError).toBe(true)
  expect((await call(ctx, 'jev_list', {})).isError).toBe(true)
  await fiber.dispose()
  expect(ctx.get('jevRuns')).toBeUndefined()
  for (const name of ['jev_run', 'jev_list', 'jev_control']) expect(ctx.tools.get(name)).toBeUndefined()
})

it('composes optional sources with explicit addressing and removes their contributions on disposal', async () => {
  const { ctx, project, agent } = await boot()
  const calls: unknown[] = []
  const adapter: Runs.JevRunSource = {
    list: async root => [{ id: 'same-id', record: { root } }], read: async (root, id) => ({ root, id }),
    run: async (root, input, owner) => { calls.push([root, input, owner.id]); return { started: true } },
    control: async (root, id, action, owner) => { calls.push([root, id, action, owner.id]); return { runId: id, outcome: 'requested' } },
  }
  const fiber = ctx.plugin({ inject: ['jevRuns'], apply(child: Context) { child.effect(() => child.jevRuns.registerSource('custom-source', adapter)) } }); await fiber
  expect(await ctx.jevRuns.list(project)).toEqual([{ source: 'custom-source', id: 'same-id', record: { root: project } }])
  expect(await ctx.jevRuns.list(project, { source: 'custom-source', id: 'same-id' })).toEqual([{ source: 'custom-source', id: 'same-id', record: { root: project, id: 'same-id' } }])
  expect(value(await call(ctx, 'jev_run', { source: 'custom-source', title: 'custom' }, agent))).toEqual({ started: true })
  expect(value(await call(ctx, 'jev_control', { source: 'custom-source', id: 'same-id', action: 'cancel' }, agent))).toEqual({ runId: 'same-id', outcome: 'requested' })
  expect(calls).toEqual([[project, { source: 'custom-source', title: 'custom' }, agent.id], [project, 'same-id', 'cancel', agent.id]])
  expect(() => ctx.jevRuns.registerSource('custom-source', adapter)).toThrow('already registered')
  expect(() => ctx.jevRuns.registerSource('generic', adapter)).toThrow('reserved')
  expect(() => ctx.jevRuns.registerSource('../outside', adapter)).toThrow('reserved')
  await fiber.dispose()
  await expect(ctx.jevRuns.list(project, { source: 'custom-source' })).rejects.toThrow('unavailable')
  await expect(ctx.jevRuns.run(project, { source: 'missing' }, agent)).rejects.toThrow('unavailable')
  const dispose = ctx.jevRuns.registerSource('read-only', { list: async () => [], read: async () => ({}) })
  await expect(ctx.jevRuns.run(project, { source: 'read-only' }, agent)).rejects.toThrow('read-only')
  await expect(ctx.jevRuns.control(project, { source: 'read-only', id: 'x', action: 'resume' }, agent)).rejects.toThrow('does not support')
  dispose(); dispose()
  expect(await ctx.jevRuns.list(project)).toEqual([])
})

it('controls real owner-scoped jobs and refuses invalid resume states', async () => {
  const { ctx, project, agent } = await boot()
  const started = await ctx.jevRuns.run(project, { title: 'Waiting', evidence: 'wait', questions: ['Is it ready?'] }, agent) as JevRunSnapshot & { jobId: string }
  const foreign = owner(ctx, 'foreign', project)
  const input = { source: 'generic', id: started.definition.id, action: 'cancel' as const }
  expect((await call(ctx, 'jev_control', input, foreign)).isError).toBe(true)
  await expect(ctx.jevRuns.control(project, { ...input, action: 'resume' }, agent)).rejects.toThrow('cannot resume from running')
  expect(value(await call(ctx, 'jev_control', input, agent))).toEqual({ runId: input.id, outcome: 'requested' })
  await ctx.jobs.wait(JobId(started.jobId), 2000, agent)
  await expect.poll(async () => (await ctx.jevRuns.durable.inspect(join(project, '.jev'), input.id)).state.status).toBe('cancelled')
  const resumed = value(await call(ctx, 'jev_control', { ...input, action: 'resume' }, agent)) as { jobId: string }
  expect(resumed.jobId).not.toBe(started.jobId)
  await ctx.jevRuns.control(project, input, agent)
  await ctx.jobs.wait(JobId(resumed.jobId), 2000, agent)
})

it('presents each operation and rejects sessions without a workspace', async () => {
  const { ctx, agent } = await boot()
  expect(ctx.tools.get('jev_run')?.presentCall?.({})).toMatchObject({ title: 'Start JEV review' })
  expect(ctx.tools.get('jev_list')?.presentCall?.({})).toMatchObject({ title: 'List JEV records' })
  expect(ctx.tools.get('jev_list')?.presentCall?.({ id: 'x' })).toMatchObject({ title: 'Inspect JEV record x' })
  expect(ctx.tools.get('jev_control')?.presentCall?.({ source: 'generic', id: 'x', action: 'cancel' })).toMatchObject({ title: 'Cancel JEV run x' })
  expect(ctx.tools.get('jev_control')?.presentCall?.({ source: 'generic', id: 'x', action: 'resume' })).toMatchObject({ title: 'Resume JEV run x' })
  const session = ctx.sessions.create(SessionId('no-workspace'), {})
  expect((await call(ctx, 'jev_list', {}, { ...agent, session })).isError).toBe(true)
})

it('refuses unbound cancellation and serializes competing resumes', async () => {
  const { ctx, project, agent } = await boot()
  const definition = { id: 'resumable', scope: { kind: 'custom', id: 'x', title: 'X' }, template: { id: 'test', version: '1' }, createdAt: '2026-09-23', checks: [{ id: 'x', subject: { kind: 'custom', id: 'x', title: 'X' }, evidenceDigest: 'x', request: { state: 'wait', questions: { answer: { type: 'noul' as const, instructions: 'Ready?' } } } }] }
  await ctx.jevRuns.durable.prepare(join(project, '.jev'), definition)
  await expect(ctx.jevRuns.cancel(join(project, '.jev'), definition.id, agent)).rejects.toThrow('no cancellable job')
  const results = await Promise.allSettled([ctx.jevRuns.resume(join(project, '.jev'), definition.id, agent), ctx.jevRuns.resume(join(project, '.jev'), definition.id, agent)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const job = ctx.jobs.list(agent)[0]
  if (job === undefined) throw new Error('Missing job')
  expect(ctx.jobs.read(job.id, agent).text).toContain('running 0/1')
  expect(ctx.jobs.read(job.id, agent).text).toBe('')
  await ctx.jevRuns.cancel(join(project, '.jev'), definition.id, agent)
  await ctx.jobs.wait(job.id, 2000, agent)
})

it('reports runner failures and cancels jobs when their binding cannot persist', async () => {
  const { ctx, project, agent } = await boot()
  const root = join(project, '.jev')
  const base = { scope: { kind: 'custom', id: 'x', title: 'X' }, template: { id: 'test', version: '1' }, createdAt: '2026-09-23', checks: [] }
  for (const [index, error] of [new Error('storage failed'), 'plain failure'].entries()) {
    const execute = vi.spyOn(ctx.jevRuns.durable, 'execute').mockRejectedValueOnce(error)
    const result = await ctx.jevRuns.start(root, { ...base, id: `failure-${index}` }, agent)
    await expect(ctx.jobs.wait(JobId(result.jobId), 2000, agent)).resolves.toMatchObject({ status: 'failed' })
    execute.mockRestore()
  }
  const execute = vi.spyOn(ctx.jevRuns.durable, 'execute').mockImplementationOnce(async (_root, _id, _hooks, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }) }))
  const bind = vi.spyOn(ctx.jevRuns.durable, 'bindJob').mockRejectedValueOnce(new Error('binding failed'))
  await expect(ctx.jevRuns.start(root, { ...base, id: 'binding-failed' }, agent)).rejects.toThrow('binding failed')
  const job = ctx.jobs.list(agent).find(job => job.label === 'JEV run binding-failed')
  if (job === undefined) throw new Error('Missing failed job')
  await expect(ctx.jobs.wait(job.id, 2000, agent)).resolves.toMatchObject({ status: 'killed' })
  execute.mockRestore(); bind.mockRestore()
})
