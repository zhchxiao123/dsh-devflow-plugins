import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JevRunDefinition } from './runs.ts'
import { JevRunEngine } from './runs.ts'
import { DurableJevRuns, type JevRunSnapshot } from './run-store.ts'

declare module '@deepseek-ai/cordis' { interface Context { jevRuns: GenericJevRuns } }
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'jev-run': 'jev-run' } }
export const name = 'jev-runs'
export const inject = ['jev', 'tools', 'jobs']

function root(exec: ToolRunContext): string { const cwd = exec.agent?.session.header.cwd; if (cwd === undefined) throw new Error('dsh-jev: runs require an owning workspace session'); return join(cwd, '.jev') }
function owner(exec: ToolRunContext): Agent { if (exec.agent === undefined) throw new Error('dsh-jev: runs require a live owning agent'); return exec.agent }
function parse(text: string): JevRunDefinition { const value: unknown = JSON.parse(text); if (value === null || typeof value !== 'object') throw new Error('dsh-jev: definitionJson must contain an object'); return value as JevRunDefinition }

/** Tools and browser adapters share the same live-owner job lifecycle. */
export class GenericJevRuns extends Service {
  static inject = ['jev', 'jobs']
  private readonly operations = new Map<string, Promise<void>>()
  readonly durable: DurableJevRuns
  constructor(ctx: Context) { super(ctx, 'jevRuns'); this.durable = new DurableJevRuns(new JevRunEngine(ctx.jev)) }

  async start(root: string, definition: JevRunDefinition, owner: Agent): Promise<JevRunSnapshot & { jobId: string }> {
    return this.withRun(root, definition.id, async () => {
      const prepared = await this.durable.prepare(root, definition)
      const jobId = await this.launch(root, definition.id, owner)
      return { ...prepared, jobId }
    })
  }

  async resume(root: string, runId: string, owner: Agent): Promise<{ runId: string; jobId: string }> {
    return this.withRun(root, runId, async () => {
      const current = await this.durable.inspect(root, runId)
      if (!['interrupted', 'cancelled', 'completed-with-errors'].includes(current.state.status)) throw new Error(`dsh-jev: run ${runId} cannot resume from ${current.state.status}`)
      return { runId, jobId: await this.launch(root, runId, owner) }
    })
  }

  async cancel(root: string, runId: string, owner: Agent): Promise<{ runId: string; outcome: 'requested' | 'already-finished' }> {
    return this.withRun(root, runId, async () => {
      const current = await this.durable.inspect(root, runId)
      if (current.state.jobId === undefined) throw new Error('dsh-jev: run has no cancellable job')
      return { runId, outcome: this.ctx.jobs.kill(JobId(current.state.jobId), owner, 'generic JEV run cancelled') }
    })
  }

  /** Serializes lifecycle controls until the job binding and runner startup agree. */
  private async withRun<T>(root: string, runId: string, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([root, runId]); const previous = this.operations.get(key)
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve) => { release = resolve })
    this.operations.set(key, current)
    await previous
    try { return await operation() } finally { release?.(); if (this.operations.get(key) === current) this.operations.delete(key) }
  }

  private async launch(root: string, runId: string, owner: Agent): Promise<string> {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const jobId = this.ctx.jobs.start({ kind: 'jev-run', owner, label: `JEV run ${runId}`, run: () => {
      const controller = new AbortController(); let output = ''
      const done: Promise<JobOutcome> = this.durable.execute(root, runId, { onState: (state) => { output = `${state.status} ${state.completed}/${state.total}\n`; markStarted?.() } }, controller.signal).then(
        value => ({ status: controller.signal.aborted ? 'killed' as const : 'completed' as const, output: JSON.stringify(value) }),
        (error: unknown) => ({ status: controller.signal.aborted ? 'killed' as const : 'failed' as const, output: error instanceof Error ? error.message : String(error) }),
      ).finally(() => { markStarted?.() })
      return { cancel: () => { controller.abort() }, done, readOutput: () => { const value = output; output = ''; return value } }
    } })
    try { await this.durable.bindJob(root, runId, jobId) } catch (error: unknown) {
      this.ctx.jobs.kill(JobId(jobId), owner, 'generic JEV job binding failed')
      throw error
    }
    await started
    return jobId
  }
}

function register(ctx: Context): void {
  const add = (definition: ToolDefinition): void => { ctx.effect(() => ctx.tools.register(definition)) }
  const output = { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] } as const
  add(defineTool({ name: 'jev_start_run', description: 'Start a durable domain-neutral JEV run in the current workspace. definitionJson follows JevRunDefinition and may describe repository, GitHub, Devflow, or other subjects.', parameters: { definitionJson: { type: 'string', required: true } }, output, execute: async (args, exec) => ({ text: JSON.stringify(await ctx.jevRuns.start(root(exec), parse(args.definitionJson), owner(exec))) }), presentCall: () => ({ card: 'generic', kind: 'read', title: 'Start generic JEV run' }) }))
  add(defineTool({ name: 'jev_runs', description: 'List generic JEV runs in the current workspace, or inspect one by runId.', parameters: { runId: { type: 'string' } }, output, execute: async (args, exec) => ({ text: JSON.stringify(args.runId === undefined ? await ctx.jevRuns.durable.list(root(exec)) : await ctx.jevRuns.durable.inspect(root(exec), args.runId)) }), presentCall: args => ({ card: 'generic', kind: 'read', title: args.runId === undefined ? 'List JEV runs' : `Inspect JEV run ${args.runId}` }) }))
  add(defineTool({ name: 'jev_resume_run', description: 'Resume a cancelled, interrupted, or partially failed generic JEV run.', parameters: { runId: { type: 'string', required: true } }, output, execute: async (args, exec) => ({ text: JSON.stringify(await ctx.jevRuns.resume(root(exec), args.runId, owner(exec))) }), presentCall: args => ({ card: 'generic', kind: 'edit', title: `Resume JEV run ${args.runId}` }) }))
  add(defineTool({ name: 'jev_cancel_run', description: 'Cancel the owner-scoped Harness job for a generic JEV run.', parameters: { runId: { type: 'string', required: true } }, output, execute: async (args, exec) => ({ text: JSON.stringify(await ctx.jevRuns.cancel(root(exec), args.runId, owner(exec))) }), presentCall: args => ({ card: 'generic', kind: 'edit', title: `Cancel JEV run ${args.runId}` }) }))
}

export function apply(ctx: Context): void { ctx.plugin(GenericJevRuns); ctx.inject(['jevRuns'], (child) => { register(child) }) }
