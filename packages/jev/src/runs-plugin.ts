import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JevRunDefinition } from './runs.ts'
import { JevRunEngine } from './runs.ts'
import { DurableJevRuns } from './run-store.ts'

declare module '@deepseek-ai/cordis' { interface Context { jevRuns: GenericJevRuns } }
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'jev-run': 'jev-run' } }
export const name = 'jev-runs'
export const inject = ['jev', 'tools', 'jobs']

function root(exec: ToolRunContext): string { const cwd = exec.agent?.session.header.cwd; if (cwd === undefined) throw new Error('dsh-jev: runs require an owning workspace session'); return join(cwd, '.jev') }
function parse(text: string): JevRunDefinition { const value: unknown = JSON.parse(text); if (value === null || typeof value !== 'object') throw new Error('dsh-jev: definitionJson must contain an object'); return value as JevRunDefinition }

export class GenericJevRuns extends Service {
  static inject = ['jev']
  readonly durable: DurableJevRuns
  constructor(ctx: Context) { super(ctx, 'jevRuns'); this.durable = new DurableJevRuns(new JevRunEngine(ctx.jev)) }
}

function start(ctx: Context, exec: ToolRunContext, runRoot: string, runId: string): string {
  const owner = exec.agent; if (owner === undefined) throw new Error('dsh-jev: runs require a live owning agent')
  const id = ctx.jobs.start({ kind: 'jev-run', owner, label: `JEV run ${runId}`, run: () => { const controller = new AbortController(); let output = ''; const done: Promise<JobOutcome> = ctx.jevRuns.durable.execute(runRoot, runId, { onState: (state) => { output = `${state.status} ${state.completed}/${state.total}\n` } }, controller.signal).then(value => ({ status: controller.signal.aborted ? 'killed' as const : 'completed' as const, output: JSON.stringify(value) }), (error: unknown) => ({ status: controller.signal.aborted ? 'killed' as const : 'failed' as const, output: error instanceof Error ? error.message : String(error) })); return { cancel: () => { controller.abort() }, done, readOutput: () => { const value = output; output = ''; return value } } } })
  return id
}

function register(ctx: Context): void {
  const add = (definition: ToolDefinition): void => { ctx.effect(() => ctx.tools.register(definition)) }
  const output = { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] } as const
  add(defineTool({ name: 'jev_start_run', description: 'Start a durable domain-neutral JEV run in the current workspace. definitionJson follows JevRunDefinition and may describe repository, GitHub, Devflow, or other subjects.', parameters: { definitionJson: { type: 'string', required: true } }, output, execute: async (args, exec) => { const runRoot = root(exec); const definition = parse(args.definitionJson); const prepared = await ctx.jevRuns.durable.prepare(runRoot, definition); const jobId = start(ctx, exec, runRoot, definition.id); await ctx.jevRuns.durable.bindJob(runRoot, definition.id, jobId); return { text: JSON.stringify({ ...prepared, jobId }) } }, presentCall: () => ({ card: 'generic', kind: 'read', title: 'Start generic JEV run' }) }))
  add(defineTool({ name: 'jev_runs', description: 'List generic JEV runs in the current workspace, or inspect one by runId.', parameters: { runId: { type: 'string' } }, output, execute: async (args, exec) => ({ text: JSON.stringify(args.runId === undefined ? await ctx.jevRuns.durable.list(root(exec)) : await ctx.jevRuns.durable.inspect(root(exec), args.runId)) }), presentCall: args => ({ card: 'generic', kind: 'read', title: args.runId === undefined ? 'List JEV runs' : `Inspect JEV run ${args.runId}` }) }))
  add(defineTool({ name: 'jev_resume_run', description: 'Resume a cancelled, interrupted, or partially failed generic JEV run.', parameters: { runId: { type: 'string', required: true } }, output, execute: async (args, exec) => { const runRoot = root(exec); const current = await ctx.jevRuns.durable.inspect(runRoot, args.runId); if (!['interrupted', 'cancelled', 'completed-with-errors'].includes(current.state.status)) throw new Error(`dsh-jev: run ${args.runId} cannot resume from ${current.state.status}`); const jobId = start(ctx, exec, runRoot, args.runId); await ctx.jevRuns.durable.bindJob(runRoot, args.runId, jobId); return { text: JSON.stringify({ runId: args.runId, jobId }) } }, presentCall: args => ({ card: 'generic', kind: 'edit', title: `Resume JEV run ${args.runId}` }) }))
  add(defineTool({ name: 'jev_cancel_run', description: 'Cancel the owner-scoped Harness job for a generic JEV run.', parameters: { runId: { type: 'string', required: true } }, output, execute: async (args, exec) => { const current = await ctx.jevRuns.durable.inspect(root(exec), args.runId); if (current.state.jobId === undefined || exec.agent === undefined) throw new Error('dsh-jev: run has no cancellable job'); return { text: JSON.stringify({ runId: args.runId, outcome: ctx.jobs.kill(JobId(current.state.jobId), exec.agent, 'generic JEV run cancelled') }) } }, presentCall: args => ({ card: 'generic', kind: 'edit', title: `Cancel JEV run ${args.runId}` }) }))
}

export function apply(ctx: Context): void { ctx.plugin(GenericJevRuns); ctx.inject(['jevRuns'], (child) => { register(child) }) }
