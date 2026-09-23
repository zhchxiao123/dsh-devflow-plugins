import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JevRunDefinition } from './runs.ts'
import { JevRunEngine } from './runs.ts'
import { DurableJevRuns, type JevRunSnapshot } from './run-store.ts'
import { registerGuidance } from './guidance.ts'
import { genericDefinition } from './run-input.ts'
import type { JevRunInput, JevRunSource, JevListRecord, JevControlResult } from './run-types.ts'
export type { JevRunInput, JevRunSource, JevListRecord, JevControlResult } from './run-types.ts'

declare module '@deepseek-ai/cordis' { interface Context { jevRuns: GenericJevRuns } }
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'jev-run': 'jev-run' } }
export const name = 'jev-runs'
export const inject = ['jev', 'tools', 'jobs']

function root(exec: ToolRunContext): string { const cwd = owner(exec).session.header.cwd; if (cwd === undefined) throw new Error('dsh-jev: runs require an owning workspace session'); return cwd }
function owner(exec: ToolRunContext): Agent { if (exec.agent === undefined) throw new Error('dsh-jev: runs require a live owning agent'); return exec.agent }

/** Tools and browser adapters share the same live-owner job lifecycle. */
export class GenericJevRuns extends Service {
  static inject = ['jev', 'jobs']
  private readonly operations = new Map<string, Promise<void>>()
  private readonly sources = new Map<string, JevRunSource>()
  readonly durable: DurableJevRuns
  constructor(ctx: Context) { super(ctx, 'jevRuns'); this.durable = new DurableJevRuns(new JevRunEngine(ctx.jev)) }

  registerSource(source: string, adapter: JevRunSource): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(source) || source === 'generic') throw new Error('dsh-jev: invalid or reserved source')
    if (this.sources.has(source)) throw new Error(`dsh-jev: source ${source} is already registered`)
    this.sources.set(source, adapter)
    let active = true
    return () => { if (active) { active = false; this.sources.delete(source) } }
  }

  private source(name: string): JevRunSource {
    const source = this.sources.get(name)
    if (source === undefined) throw new Error(`dsh-jev: source ${name} is unavailable`)
    return source
  }

  async run(project: string, input: JevRunInput, owner: Agent): Promise<unknown> {
    const name = input.source ?? 'generic'
    if (name === 'generic') return this.start(join(project, '.jev'), genericDefinition(input), owner)
    const source = this.source(name)
    if (source.run === undefined) throw new Error(`dsh-jev: source ${name} is read-only; use its assessment tool to create records`)
    return source.run(project, input, owner)
  }

  async list(project: string, input: { readonly source?: string; readonly id?: string } = {}): Promise<JevListRecord[]> {
    if (input.id !== undefined && input.source === undefined) throw new Error('dsh-jev: id requires source')
    const names = input.source === undefined ? ['generic', ...this.sources.keys()] : [input.source]
    const lists = await Promise.all(names.map(async (source) => {
      if (source === 'generic') {
        const records = input.id === undefined ? await this.durable.list(join(project, '.jev')) : [await this.durable.inspect(join(project, '.jev'), input.id)]
        return records.map(record => ({ source, id: record.definition.id, record }))
      }
      const adapter = this.source(source)
      if (input.id !== undefined) return [{ source, id: input.id, record: await adapter.read(project, input.id) }]
      return (await adapter.list(project)).map(record => ({ source, ...record }))
    }))
    return lists.flat()
  }

  async control(project: string, input: { readonly source: string; readonly id: string; readonly action: 'resume' | 'cancel' }, owner: Agent): Promise<JevControlResult> {
    if (input.source === 'generic') return input.action === 'resume' ? this.resume(join(project, '.jev'), input.id, owner) : this.cancel(join(project, '.jev'), input.id, owner)
    const source = this.source(input.source)
    if (source.control === undefined) throw new Error(`dsh-jev: source ${input.source} does not support run controls`)
    return source.control(project, input.id, input.action, owner)
  }

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
  add(defineTool({
    name: 'jev_run',
    description: 'Start a durable JEV review. source defaults to generic: supply title, evidence, and yes/no questions, or advanced definitionJson (JevRunDefinition). Uses supplied evidence only, without source scanning. With source devflow-audit, supply profile and optional maxCards. Use jev_list to inspect progress.',
    parameters: {
      source: { type: 'string' }, definitionJson: { type: 'string' }, title: { type: 'string' }, evidence: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } },
      profile: { type: 'string' }, maxCards: { type: 'integer' },
    }, output, execute: async (args, exec) => ({ text: JSON.stringify(await ctx.jevRuns.run(root(exec), args, owner(exec))) }),
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Start JEV review' }),
  }))
  add(defineTool({
    name: 'jev_list', description: 'List JEV records in this workspace across installed sources, or inspect one with source and id. Sources include generic and, when installed, devflow-audit and devflow-assessment. An id requires its source.',
    parameters: { source: { type: 'string' }, id: { type: 'string' } }, output,
    execute: async (args, exec) => ({ text: JSON.stringify(await ctx.jevRuns.list(root(exec), args)) }),
    presentCall: args => ({ card: 'generic', kind: 'read', title: args.id === undefined ? 'List JEV records' : `Inspect JEV record ${args.id}` }),
  }))
  add(defineTool({
    name: 'jev_control', description: 'Resume or cancel a durable JEV run by source and id. Resume retains completed checks; cancellation follows Harness job ownership. Assessment records do not support lifecycle controls.',
    parameters: { source: { type: 'string', required: true }, id: { type: 'string', required: true }, action: { type: 'string', enum: ['resume', 'cancel'], required: true } }, output,
    execute: async (args, exec) => ({ text: JSON.stringify(await ctx.jevRuns.control(root(exec), args, owner(exec))) }),
    presentCall: args => ({ card: 'generic', kind: 'edit', title: `${args.action === 'resume' ? 'Resume' : 'Cancel'} JEV run ${args.id}` }),
  }))
}

export function apply(ctx: Context): void { ctx.plugin(GenericJevRuns); ctx.inject(['jevRuns'], (child) => { register(child); child.inject(['systemPrompt'], registerGuidance) }) }
