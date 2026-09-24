/* oxlint-disable @stylistic/max-len */
// Generic runs execute inside the calling operation and hand back their
// answers: nothing is left running in the background for a process exit to
// orphan. Cancellation persists an honest `cancelled` state that resume picks
// up with finished checks retained.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
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
  await ctx.plugin(SystemPrompt); await ctx.plugin(Sessions); await ctx.plugin(AgentRegistry); await ctx.plugin(Tools); await ctx.plugin(Provider)
  const fiber = ctx.plugin(Runs); await fiber
  return { ctx, project, fiber, agent: owner(ctx, 'owner', project) }
}
function call(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({ name, arguments: args, ...(agent === undefined ? {} : { agent }), callId: ToolCallId('jev-tool-call'), signal: new AbortController().signal })
}
function value(result: Awaited<ReturnType<typeof call>>): unknown {
  return JSON.parse(result.content.map(block => 'text' in block ? block.text : '').join('\n')) as unknown
}

it('exposes three tools without Devflow and answers simple and advanced runs within the call', async () => {
  const { ctx, project, agent, fiber } = await boot()
  for (const name of ['jev_run', 'jev_list', 'jev_control']) expect(ctx.tools.get(name)).toBeDefined()
  for (const name of ['jev_start_run', 'jev_runs', 'jev_resume_run', 'jev_cancel_run']) expect(ctx.tools.get(name)).toBeUndefined()
  const result = await call(ctx, 'jev_run', { title: 'Checklist', evidence: 'Report', questions: ['Is it ready?', 'Is it tested?'] }, agent)
  expect(result.isError).toBeFalsy()
  const finished = value(result) as JevRunSnapshot
  // The tool call itself carries the answers; nothing is pending afterwards.
  expect(finished.state).toMatchObject({ status: 'completed', completed: 2, failed: 0 })
  expect(finished.state.results[0]?.response?.answers).toMatchObject({ answer: { type: 'noul', noul: 0.8 } })
  expect(finished.definition.checkTimeoutMs).toBe(60_000)
  expect(value(await call(ctx, 'jev_list', {}, agent))).toMatchObject([{ source: 'generic', id: finished.definition.id, record: { definition: { scope: { title: 'Checklist' } }, state: { completed: 2 } } }])
  expect(value(await call(ctx, 'jev_list', { source: 'generic', id: finished.definition.id }, agent))).toMatchObject([{ record: { state: { completed: 2 } } }])
  expect(await ctx.jevRuns.list(join(project, 'other'))).toEqual([])
  const advanced = await call(ctx, 'jev_run', { definitionJson: JSON.stringify({ ...finished.definition, id: 'advanced' }) }, agent)
  expect(advanced.isError).toBeFalsy()
  expect((value(advanced) as JevRunSnapshot).state.status).toBe('completed')
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
  // Adapters keep requiring a live owner even though generic runs do not.
  await expect(ctx.jevRuns.run(project, { source: 'custom-source' })).rejects.toThrow('live owning agent')
  await expect(ctx.jevRuns.control(project, { source: 'custom-source', id: 'x', action: 'resume' })).rejects.toThrow('live owning agent')
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

it('cancels an executing run in place and resumes it with finished checks retained', async () => {
  const { ctx, project } = await boot()
  const root = join(project, '.jev')
  const check = (id: string, state: string) => ({ id, subject: { kind: 'custom', id, title: id }, evidenceDigest: id, request: { state, questions: { answer: { type: 'noul' as const, instructions: 'Ready?' } } } })
  const definition = { id: 'resumable', scope: { kind: 'custom', id: 'x', title: 'X' }, template: { id: 'test', version: '1' }, createdAt: '2026-09-23', checks: [check('done-first', 'go'), check('hangs', 'wait')] }
  expect(ctx.jevRuns.cancel(root, definition.id)).toEqual({ runId: definition.id, outcome: 'already-finished' })
  const started = ctx.jevRuns.start(root, definition)
  await expect.poll(() => ctx.jevRuns.cancel(root, definition.id).outcome).toBe('requested')
  expect((await started).state).toMatchObject({ status: 'cancelled', completed: 1 })
  // Competing resumes serialize: the second queues behind the first, each
  // hangs on the unfinished check, and one cancel per execution settles them.
  const first = ctx.jevRuns.resume(root, definition.id)
  const second = ctx.jevRuns.resume(root, definition.id)
  await expect.poll(() => ctx.jevRuns.cancel(root, definition.id).outcome).toBe('requested')
  expect((await first).state).toMatchObject({ status: 'cancelled', completed: 1 })
  await expect.poll(() => ctx.jevRuns.cancel(root, definition.id).outcome).toBe('requested')
  expect((await second).state).toMatchObject({ status: 'cancelled', completed: 1 })
  await expect(ctx.jevRuns.resume(root, 'missing')).rejects.toThrow()
})

it('honours the caller signal: pre-aborted starts cancel immediately and a mid-run abort settles as cancelled', async () => {
  const { ctx, project } = await boot()
  const root = join(project, '.jev')
  const check = (id: string, state: string) => ({ id, subject: { kind: 'custom', id, title: id }, evidenceDigest: id, request: { state, questions: { answer: { type: 'noul' as const, instructions: 'Ready?' } } } })
  const base = { scope: { kind: 'custom', id: 'x', title: 'X' }, template: { id: 'test', version: '1' }, createdAt: '2026-09-23' }
  const preAborted = new AbortController(); preAborted.abort()
  expect((await ctx.jevRuns.start(root, { ...base, id: 'pre-aborted', checks: [check('one', 'go')] }, preAborted.signal)).state)
    .toMatchObject({ status: 'cancelled', completed: 0 })
  const caller = new AbortController()
  const hanging = ctx.jevRuns.start(root, { ...base, id: 'mid-abort', checks: [check('hangs', 'wait')] }, caller.signal)
  await expect.poll(async () => (await ctx.jevRuns.durable.inspect(root, 'mid-abort')).state.status).toBe('running')
  caller.abort()
  expect((await hanging).state).toMatchObject({ status: 'cancelled', completed: 0 })
})

it('rejects resume of a run that is not resumable and surfaces execution failures to the caller', async () => {
  const { ctx, project } = await boot()
  const root = join(project, '.jev')
  const base = { scope: { kind: 'custom', id: 'x', title: 'X' }, template: { id: 'test', version: '1' }, createdAt: '2026-09-23', checks: [] }
  const finished = await ctx.jevRuns.start(root, { ...base, id: 'empty' })
  expect(finished.state.status).toBe('completed')
  await expect(ctx.jevRuns.resume(root, 'empty')).rejects.toThrow('cannot resume from completed')
  const execute = vi.spyOn(ctx.jevRuns.durable, 'execute').mockRejectedValueOnce(new Error('storage failed'))
  await expect(ctx.jevRuns.start(root, { ...base, id: 'failing' })).rejects.toThrow('storage failed')
  execute.mockRestore()
  // The prepared definition inherited the configured deadline even though execution failed.
  expect((await ctx.jevRuns.durable.inspect(root, 'failing')).definition.checkTimeoutMs).toBe(60_000)
})

it('presents each operation and rejects sessions without a workspace', async () => {
  const { ctx, agent } = await boot()
  expect(ctx.tools.get('jev_run')?.presentCall?.({})).toMatchObject({ title: 'Run JEV review' })
  expect(ctx.tools.get('jev_list')?.presentCall?.({})).toMatchObject({ title: 'List JEV records' })
  expect(ctx.tools.get('jev_list')?.presentCall?.({ id: 'x' })).toMatchObject({ title: 'Inspect JEV record x' })
  expect(ctx.tools.get('jev_control')?.presentCall?.({ source: 'generic', id: 'x', action: 'cancel' })).toMatchObject({ title: 'Cancel JEV run x' })
  expect(ctx.tools.get('jev_control')?.presentCall?.({ source: 'generic', id: 'x', action: 'resume' })).toMatchObject({ title: 'Resume JEV run x' })
  const session = ctx.sessions.create(SessionId('no-workspace'), {})
  expect((await call(ctx, 'jev_list', {}, { ...agent, session })).isError).toBe(true)
})

it('rejects an invalid deadline at load and keeps headless run tools active with optional guidance', async () => {
  const bad = new Context()
  await bad.plugin(Provider)
  expect(() => new Runs.GenericJevRuns(bad, { checkTimeoutMs: 0 })).toThrow('checkTimeoutMs must be a positive finite number')
  const ctx = new Context(); context = ctx
  await ctx.plugin(Provider)
  const definitions = new Set<string>()
  // This headless host does not assemble tools; the full implementation composes above.
  ctx.provide('tools', { register: (definition: { name: string }) => { definitions.add(definition.name); return () => { definitions.delete(definition.name) } } })
  await ctx.plugin(Runs)
  expect(ctx.get('jevRuns')).toBeDefined()
  expect(definitions.size).toBe(3)
  expect(ctx.get('systemPrompt')).toBeUndefined()
  const prompt = ctx.plugin(SystemPrompt); await prompt
  expect((await ctx.systemPrompt.assemble()).contexts.map(context => context.name)).toContain('jev-usage')
  await prompt.dispose()
  expect(ctx.get('systemPrompt')).toBeUndefined()
  expect(ctx.get('jevRuns')).toBeDefined()
  expect(definitions.size).toBe(3)
  await ctx.plugin(SystemPrompt)
  expect((await ctx.systemPrompt.assemble()).contexts.filter(context => context.name === 'jev-usage')).toHaveLength(1)
})
