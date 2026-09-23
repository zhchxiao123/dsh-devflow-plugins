/* oxlint-disable @stylistic/max-len */
/** Real git, tool execution, card store, and public agent hooks; only the judgement provider is scripted. */
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionRegistry, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevConfigurationStatus, JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import { emptyInbox } from '../../../tests/agent-double.ts'
import { DevflowAssistance } from '../src/assistance.ts'
import { assistanceConfig } from '../src/assistance-config.ts'
import type { AssistanceConfig } from '../src/assistance-types.ts'

const exec = promisify(execFile)
const response: JevResponse = { model: 'fixture-jev', usage: { inputTokens: 100, outputTokens: 10 }, answers: {
  action: { type: 'choice', choice: 'add-verification', probabilities: { 'add-verification': 1 }, confidence: 0.95 },
  focus: { type: 'choice', choice: 'scope', probabilities: { scope: 1 }, confidence: 0.95 },
  target: { type: 'choice', choice: 'scope', probabilities: { scope: 1 }, confidence: 0.95 },
  justified: { type: 'noul', noul: 0.98 },
} }
class FixtureJev extends JevRuntime {
  requests: JevRequest[] = []
  configured: JevConfigurationStatus = 'configured'
  configuration: (() => Promise<JevConfigurationStatus>) | undefined
  identity: string | undefined
  handler: (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse> = () => Promise.resolve(response)
  override configurationStatus(): Promise<JevConfigurationStatus> { return this.configuration?.() ?? Promise.resolve(this.configured) }
  override configurationIdentity(): string | undefined { return this.identity }
  protected perform(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    this.requests.push(request)
    return this.handler(request, signal)
  }
}
const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function boot(overrides: Partial<AssistanceConfig> = {}, previous?: string, initializeTurn = true) {
  const project = previous ?? await realpath(await mkdtemp(join(tmpdir(), 'jev-assistance-')))
  if (previous === undefined) {
    directories.push(project)
    await exec('git', ['init', '-q', project])
    await writeFile(join(project, '.gitignore'), '.devflow/\n')
    await writeFile(join(project, 'archive.ts'), 'export const archived = false\n')
    await exec('git', ['-C', project, 'add', '.'])
    await exec('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial'])
  }
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(SessionRegistry).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(FilesystemDevflowStore, { root: join(project, '.devflow') }).await()
  await ctx.plugin(FixtureJev).await()
  await ctx.plugin(DevflowAssistance, assistanceConfig(overrides)).await()
  let sequence = 0
  const removeTools: (() => void)[] = []
  for (const name of ['read', 'write', 'bash', 'devflow_show', 'devflow_attach_artifact', 'jev_list']) {
    removeTools.push(ctx.tools.register(defineTool({ name, description: 'fixture tool', parameters: { kind: { type: 'string' }, command: { type: 'string' }, id: { type: 'string' }, content: { type: 'string' }, exitCode: { type: 'number' }, fail: { type: 'boolean' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true }, id: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.exitCode === 0 ? 'completed' : 'failed: expected persistence after restart' }] },
      async execute(args) {
        if (args.fail) throw new Error('fixture tool unavailable')
        if (name === 'devflow_attach_artifact') {
          await mkdir(join(project, '.devflow'), { recursive: true })
          await writeFile(join(project, '.devflow', 'fixture-design.md'), args.content ?? 'Archive persistence design')
        }
        if (name === 'write') {
          const content = args.content ?? 'export const archived = true\n'
          if (await readFile(join(project, 'archive.ts'), 'utf8') !== content) await writeFile(join(project, 'archive.ts'), content)
        }
        return { exitCode: args.exitCode ?? 0, id: args.id ?? '' }
      },
    })))
  }
  const steered: UserMessage[] = []
  const queued: UserMessage[] = []
  const id = SessionId('assistance-owner')
  const agent: Agent = { id, options: {}, session: ctx.sessions.create(id, { meta: { cwd: project } }), inbox: { ...emptyInbox(), nextStep: queued }, status: 'idle', ctx,
    followup() {}, steer(message) { steered.push(message) }, inject() {}, send() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  const step = (text = '', signal = new AbortController().signal, turn = 1): Promise<PreStepDecision> => ctx.waterfall('agent/pre-step', {
    agent, turn, step: 1, signal, messages: text === '' ? [] : [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })],
  }, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
  const tool = (name: string, args: Record<string, unknown> = {}, callId = `assistance-call-${++sequence}`) => ctx.tools.execute({ name, arguments: args, agent, callId: ToolCallId(callId), signal: new AbortController().signal })
  const plan = async (text: string, signal = new AbortController().signal, turn = 1): Promise<PreStepDecision> => {
    await step(text, signal, turn)
    await tool('devflow_attach_artifact', { kind: 'design-document', content: text })
    return step('', signal, turn)
  }
  const stopping = (signal = new AbortController().signal) => ctx.parallel('agent/turn-stopping', { agent, turn: 1, signal })
  const records = () => ctx.devflowAssistance.list(project)
  expect(agent.session.header.cwd).toBe(project)
  expect(ctx.tools.get('write', agent)).toBeDefined()
  expect(ctx.devflowAssistance.config.mode).toBe(overrides.mode ?? 'observe')
  if (initializeTurn) await step()
  const jev = ctx.jev
  if (!(jev instanceof FixtureJev)) throw new Error('fixture provider unavailable')
  return { ctx, project, agent, steered, queued, step, plan, stopping, tool, records, jev, removeTools }
}
function texts(decision: PreStepDecision): string {
  return decision.kind === 'enter' ? decision.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n') : ''
}
function deferred() {
  let resolve: (value: JevResponse) => void = () => {}
  const promise = new Promise<JevResponse>((done) => { resolve = done })
  return { promise, resolve }
}

describe('automatic development assistance through public hooks', () => {
  it('does not spend remote budget on read-only preparation in a pre-dirty checkout', async () => {
    const env = await boot({ mode: 'assist' }, undefined, false)
    await writeFile(join(env.project, 'AGENTS.md'), 'Existing user instructions')
    await writeFile(join(env.project, 'archive.ts'), 'export const archived = "existing user change"\n')
    await env.step('Implement archive search and pagination.')
    await env.tool('bash', { command: 'pwd && git status --short && git log --oneline -5' })
    await env.step()
    await env.tool('bash', { command: 'ls -la && git diff' })
    await env.step()
    await env.stopping()
    expect(env.jev.requests).toHaveLength(0)
    expect(await env.records()).toEqual([])
    await env.tool('write', { content: 'export const archived = "new task change"\n' })
    await env.step()
    expect(env.jev.requests).toHaveLength(1)
    expect(env.jev.requests[0]?.state).not.toContain('Existing user instructions')
    expect(env.jev.requests[0]?.state).toContain('new task change')
  })
  it('detects a real checkout mutation after a shell command without treating prior reads as edits', async () => {
    const env = await boot({ mode: 'observe' })
    await env.tool('bash', { command: 'git status --short' }); await env.step()
    expect(env.jev.requests).toHaveLength(0)
    await writeFile(join(env.project, 'archive.ts'), 'export const archived = "changed by shell"\n')
    await env.tool('bash', { command: 'node scripts/change-archive.mjs' }); await env.step()
    expect(env.jev.requests).toHaveLength(1)
    expect(env.jev.requests[0]?.state).toContain('changed by shell')
    expect((await env.records())[0]).toMatchObject({ event: 'changed-code', status: 'observed' })
  })
  it('keeps read-only preparation quiet when a dirty baseline cannot be captured completely', async () => {
    const env = await boot({ mode: 'observe', maxBytes: 512 }, undefined, false)
    for (let index = 0; index < 12; index++) await writeFile(join(env.project, `old-${index}.md`), 'existing change\n')
    await env.step('Implement archive.')
    await env.tool('bash', { command: 'git status --short' }); await env.step()
    expect(env.jev.requests).toHaveLength(0)
    expect(await env.records()).toEqual([])
    await env.tool('write'); await env.step()
    expect(env.jev.requests).toHaveLength(1)
  })

  it('observes a completed design checkpoint without injecting or steering', async () => {
    const env = await boot()
    expect(texts(await env.plan('实现归档和恢复，并保证重启后状态保持。'))).toBe('')
    expect(env.jev.requests).toHaveLength(1)
    expect(await env.records()).toMatchObject([{ event: 'planning', mode: 'observe', status: 'observed', action: 'add-verification', associationReason: 'no-card-observed', outcome: 'unknown' }])
    const first = (await env.records())[0]
    if (first === undefined) throw new Error('missing observed record')
    expect(await env.ctx.devflowAssistance.read(env.project, first.id)).toEqual(first)
    expect(env.steered).toEqual([])
  })
  it('delivers concrete advice through pre-step and records a later check without claiming causality', async () => {
    const env = await boot({ mode: 'assist', maxSteersPerTurn: 2 })
    expect(texts(await env.plan('Implement archive and restore with persistence.'))).toContain('focused check')
    await env.tool('write')
    await env.tool('bash', { command: 'pnpm test', exitCode: 0 })
    await env.step()
    const records = await env.records()
    expect(records).toHaveLength(2)
    expect(records.find(record => record.event === 'planning')).toMatchObject({ status: 'delivered', outcome: 'check-passed', inputTokens: 100 })
    expect(records.find(record => record.event === 'planning')?.outcomeDetail).toContain('causality')
    expect(records.find(record => record.event === 'planning')?.outcomeDetail).toContain('call assistance-call-3, exit 0')
  })
  it('checks completion after an actual change and only steers once for unchanged evidence', async () => {
    const env = await boot({ mode: 'assist' })
    await env.tool('write')
    await env.stopping()
    await env.stopping()
    expect(env.steered).toHaveLength(1)
    expect(await env.records()).toMatchObject([{ event: 'completion', status: 'delivered' }])
  })
  it('tracks a later real check after a separate edit step has already been observed', async () => {
    const env = await boot({ mode: 'assist', maxCallsPerTurn: 1 })
    env.removeTools.push(env.ctx.tools.register(defineTool({ name: 'edit', description: 'Edit archive state.', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'edited archive.ts' }] },
      async execute() { await writeFile(join(env.project, 'archive.ts'), 'export const archived = true\n'); return {} },
    })))
    await env.plan('Implement archive.'); const first = (await env.records())[0]
    if (first === undefined) throw new Error('missing planning record')
    await env.tool('edit', {}, 'archive-edit'); await env.step()
    expect((await env.ctx.devflowAssistance.read(env.project, first.id)).outcome).toBe('action-observed')
    expect((await env.ctx.devflowAssistance.read(env.project, first.id)).outcomeDetail).toContain('call archive-edit, exit unknown')
    await exec('git', ['-C', env.project, 'add', 'archive.ts'])
    await exec('git', ['-C', env.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'archive'])
    await env.tool('bash', { command: 'git commit -m archive', exitCode: 0 }, 'archive-commit'); await env.step()
    expect((await exec('git', ['-C', env.project, 'status', '--porcelain'])).stdout).toBe('')
    await env.tool('bash', { command: 'node --test', exitCode: 1 }, 'archive-test-failed'); await env.step()
    expect((await env.ctx.devflowAssistance.read(env.project, first.id)).outcome).toBe('check-failed')
    expect((await env.ctx.devflowAssistance.read(env.project, first.id)).outcomeDetail).toContain('call archive-test-failed, exit 1')
    await env.tool('bash', { command: 'node --test', exitCode: 0 }, 'archive-test-passed'); await env.step()
    expect((await env.ctx.devflowAssistance.read(env.project, first.id)).outcome).toBe('check-passed')
    expect((await env.ctx.devflowAssistance.read(env.project, first.id)).outcomeDetail).toContain('call archive-test-passed, exit 0')
    expect(env.jev.requests).toHaveLength(1)
  })
  it('does not replay a delivered completion after the service restarts', async () => {
    const env = await boot({ mode: 'assist' })
    await env.tool('write'); await env.stopping()
    expect(env.steered).toHaveLength(1)
    await env.ctx.fiber.dispose()
    const restarted = await boot({ mode: 'assist' }, env.project)
    await restarted.tool('write'); await restarted.stopping()
    expect(restarted.jev.requests).toHaveLength(0)
    expect(restarted.steered).toEqual([])
    expect(await restarted.records()).toHaveLength(1)
  })
  it('observes a write when the plugin is mounted partway through a turn', async () => {
    const env = await boot({ mode: 'assist' }, undefined, false)
    await env.tool('write'); await env.stopping()
    expect(await env.records()).toMatchObject([{ event: 'completion', turn: 1, status: 'delivered' }])
  })
  it('detects repeated failed commands and ignores ordinary reads', async () => {
    const env = await boot({ mode: 'assist' })
    await env.tool('read')
    await env.step()
    expect(env.jev.requests).toHaveLength(0)
    await env.tool('bash', { command: 'pnpm test', exitCode: 1 })
    await env.tool('bash', { command: 'pnpm test', exitCode: 1 })
    await env.step()
    expect(await env.records()).toMatchObject([{ event: 'repeated-failure', status: 'delivered' }])
  })
  it('deduplicates an unchanged request across steps and a service restart', async () => {
    const env = await boot({ mode: 'assist' })
    const request = 'Implement archive and restore with persistence.'
    await env.plan(request); await env.plan(request)
    expect(env.jev.requests).toHaveLength(1)
    await env.ctx.fiber.dispose()
    const restarted = await boot({ mode: 'assist' }, env.project)
    expect(texts(await restarted.plan(request))).toBe('')
    expect(restarted.jev.requests).toHaveLength(0)
    expect(await restarted.records()).toHaveLength(1)
  })
  it('reevaluates observed advice when assist is enabled without replaying delivered advice', async () => {
    const env = await boot(); const task = 'Implement archive with persistence.'
    await env.plan(task)
    expect(await env.records()).toMatchObject([{ status: 'observed' }])
    await env.ctx.fiber.dispose()
    const assisted = await boot({ mode: 'assist' }, env.project)
    expect(texts(await assisted.plan(task))).toContain('focused check')
    expect(assisted.jev.requests).toHaveLength(1)
    expect(await assisted.records()).toHaveLength(2)
    await assisted.ctx.fiber.dispose()
    const restarted = await boot({}, env.project)
    expect(texts(await restarted.plan(task))).toBe('')
    expect(restarted.jev.requests).toHaveLength(0)
    expect(await restarted.records()).toHaveLength(2)
  })
  it('retries missing-credential evidence once credentials become configured', async () => {
    const env = await boot({ mode: 'assist' }); const task = 'Implement archive with persistence.'
    env.jev.configured = 'unconfigured'
    await env.plan(task); await env.plan(task)
    expect(await env.records()).toHaveLength(1)
    expect(await env.records()).toMatchObject([{ status: 'unavailable', configurationStatus: 'unconfigured' }])
    expect(env.jev.requests).toHaveLength(0)
    env.jev.configured = 'configured'
    expect(texts(await env.plan(task))).toContain('focused check')
    expect(env.jev.requests).toHaveLength(1)
    expect((await env.records()).find(record => record.status === 'delivered')?.configurationStatus).toBe('configured')
  })
  it('does not repeatedly call a failing provider for the same evidence and configuration', async () => {
    const env = await boot({ mode: 'assist' })
    env.jev.handler = () => Promise.reject(new Error('provider unavailable'))
    await env.plan('Implement archive.'); await env.plan('Implement archive.')
    expect(env.jev.requests).toHaveLength(1)
    expect(await env.records()).toHaveLength(1)
  })
  it('reevaluates identical evidence when the provider configuration identity changes', async () => {
    const env = await boot({ mode: 'assist', maxSteersPerTurn: 2 })
    env.jev.identity = 'provider-model-A'
    expect(texts(await env.plan('Implement archive.'))).toContain('focused check')
    expect(texts(await env.plan('Implement archive.'))).toBe('')
    env.jev.identity = 'provider-model-B'
    expect(texts(await env.plan('Implement archive.'))).toContain('focused check')
    expect(env.jev.requests).toHaveLength(2)
    expect((await env.records()).map(record => record.providerIdentity).sort()).toEqual(['provider-model-A', 'provider-model-B'])
    expect((await env.records()).every(record => record.actionConfidence === 0.95 && record.justifiedProbability === 0.98)).toBe(true)
  })
  it('discards an in-flight judgement when the provider identity changes before delivery', async () => {
    const env = await boot({ mode: 'assist' }); const waiting = deferred()
    env.jev.identity = 'provider-model-A'; env.jev.handler = () => waiting.promise
    const pending = env.plan('Implement archive.')
    await expect.poll(() => env.jev.requests.length).toBe(1)
    env.jev.identity = 'provider-model-B'; waiting.resolve(response)
    expect(texts(await pending)).toBe('')
    expect(await env.records()).toMatchObject([{ status: 'stale', providerIdentity: 'provider-model-A' }])
    env.jev.handler = () => Promise.resolve(response)
    expect(texts(await env.plan('Implement archive.'))).toContain('focused check')
    expect(env.jev.requests).toHaveLength(2)
  })
  it('marks advice stale if real source changes while the provider is answering', async () => {
    const env = await boot({ mode: 'assist' }); const waiting = deferred()
    env.jev.handler = () => waiting.promise
    const running = env.plan('Implement persistence.')
    await expect.poll(() => env.jev.requests.length).toBe(1)
    await writeFile(join(env.project, 'archive.ts'), 'export const archived = true\n')
    waiting.resolve(response)
    expect(texts(await running)).toBe('')
    expect(await env.records()).toMatchObject([{ status: 'stale' }])
    expect(env.steered).toEqual([])
    await writeFile(join(env.project, 'archive.ts'), 'export const archived = false\n')
    env.jev.handler = () => Promise.resolve(response)
    expect(texts(await env.plan('Implement persistence.'))).toContain('focused check')
    expect(env.jev.requests).toHaveLength(2)
  })
  it('does not deliver a judgement after its card, workspace identity, or available tools change', async () => {
    const env = await boot({ mode: 'assist' }); const waiting = deferred()
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Archive', body: 'Persist archive.', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    await env.tool('devflow_show', { id: created.card.id })
    env.jev.handler = () => waiting.promise
    const running = env.plan('Implement archive.')
    await expect.poll(() => env.jev.requests.length).toBe(1)
    const attached = await env.ctx.devflow.attachArtifact({ id: created.card.id, kind: 'acceptance', content: 'New acceptance criterion.', expectedRevision: 1, by: { kind: 'human' } })
    if (!attached.ok) throw new Error(attached.message)
    Object.assign(env.agent, { session: env.ctx.sessions.create(SessionId('moved-owner'), { meta: { cwd: join(env.project, 'moved-checkout') } }) })
    env.removeTools[2]?.()
    waiting.resolve(response)
    expect(texts(await running)).toBe('')
    expect((await env.records())[0]).toMatchObject({ status: 'stale', staleReasons: ['task-changed', 'workspace-changed', 'tools-changed'] })
    expect(env.steered).toEqual([])
  })
  it('retries an identical planning request after its previous judgement was cancelled', async () => {
    const env = await boot({ mode: 'assist' }); const waiting = deferred(); const controller = new AbortController()
    env.jev.handler = () => waiting.promise
    const running = env.plan('Implement persistence.', controller.signal)
    await expect.poll(() => env.jev.requests.length).toBe(1)
    controller.abort(); waiting.resolve(response); await running
    expect(await env.records()).toMatchObject([{ status: 'cancelled' }])
    env.jev.handler = () => Promise.resolve(response)
    expect(texts(await env.plan('Implement persistence.'))).toContain('focused check')
    expect(env.jev.requests).toHaveLength(2)
  })
  it('does not steer after the user cancels a pending completion judgement', async () => {
    const env = await boot({ mode: 'assist' }); const waiting = deferred(); const controller = new AbortController()
    env.jev.handler = () => waiting.promise
    await env.tool('write')
    const running = env.stopping(controller.signal)
    await expect.poll(() => env.jev.requests.length).toBe(1)
    controller.abort(); waiting.resolve(response)
    await running
    expect(env.steered).toEqual([])
    expect(await env.records()).toMatchObject([{ status: 'cancelled' }])
  })
  it('bounds a judgement even when the external provider ignores its abort signal', async () => {
    const env = await boot({ mode: 'assist', timeoutMs: 150 }); const waiting = deferred()
    env.jev.handler = () => waiting.promise
    let settled = false
    const running = env.plan('Implement persistence.').finally(() => { settled = true })
    try { await expect.poll(() => settled, { timeout: 1000 }).toBe(true) }
    finally { waiting.resolve(response); await running }
    expect(await env.records()).toMatchObject([{ status: 'unavailable' }])
    expect((await env.records())[0]?.reason).toContain('timed out')
  })
  it('records missing credentials and provider failures without injecting advice', async () => {
    const env = await boot({ mode: 'assist' })
    env.jev.configured = 'unconfigured'
    expect(texts(await env.plan('Implement archive.'))).toBe('')
    expect(env.jev.requests).toHaveLength(0)
    expect(await env.records()).toMatchObject([{ status: 'unavailable' }])
    env.jev.configured = 'configured'; env.jev.handler = () => Promise.reject(new Error('token=private-provider-error'))
    expect(texts(await env.plan('Implement restore.'))).toBe('')
    expect(JSON.stringify(await env.records())).not.toContain('private-provider-error')
    expect((await env.records()).every(record => record.status === 'unavailable')).toBe(true)
  })
  it('records credential-resolution failures without exposing the provider error', async () => {
    const env = await boot({ mode: 'assist' })
    env.jev.configuration = () => Promise.reject(new Error('token=private-credential-error'))
    expect(texts(await env.plan('Implement archive.'))).toBe('')
    expect(await env.records()).toMatchObject([{ status: 'unavailable' }])
    expect(JSON.stringify(await env.records())).not.toContain('private-credential-error')
    expect(env.jev.requests).toHaveLength(0)
  })
  it('bounds credential resolution even if the provider never settles it', async () => {
    const env = await boot({ mode: 'assist', timeoutMs: 200 })
    let release: (value: JevConfigurationStatus) => void = () => {}
    env.jev.configuration = () => new Promise((resolve) => { release = resolve })
    let settled = false
    const running = env.plan('Implement archive.').finally(() => { settled = true })
    try { await expect.poll(() => settled, { timeout: 1500 }).toBe(true) }
    finally { release('configured'); await running }
    expect(await env.records()).toMatchObject([{ status: 'unavailable' }])
    expect(env.jev.requests).toHaveLength(0)
  })
  it('does not exceed the configured remote-call budget', async () => {
    const env = await boot({ mode: 'assist', maxCallsPerTurn: 1 })
    await env.plan('Implement archive.')
    await env.tool('write'); await env.step()
    expect(env.jev.requests).toHaveLength(1)
    expect((await env.records()).some(record => record.status === 'budget-exhausted')).toBe(true)
    await env.plan('Implement another requirement.', new AbortController().signal, 2)
    expect(env.jev.requests).toHaveLength(2)
  })
  it('retries previously budget-exhausted evidence on the next user turn', async () => {
    const env = await boot({ maxCallsPerTurn: 1 })
    await env.plan('Implement archive.')
    await env.plan('Implement restore.')
    expect(env.jev.requests).toHaveLength(1)
    await env.plan('Implement restore.', new AbortController().signal, 2)
    expect(env.jev.requests).toHaveLength(2)
  })
  it('reserves the last judgement for completion instead of spending it on intermediate checkpoints', async () => {
    const env = await boot({ maxCallsPerTurn: 2 })
    await env.plan('Implement archive.')
    await env.tool('write'); await env.step()
    expect(env.jev.requests).toHaveLength(1)
    await env.stopping()
    expect(env.jev.requests).toHaveLength(2)
    expect((await env.records()).some(record => record.event === 'completion')).toBe(true)
  })
  it('does not infer action adoption from a new user request alone', async () => {
    const env = await boot({ mode: 'assist', maxSteersPerTurn: 2 })
    await env.plan('Implement archive.')
    const first = (await env.records())[0]
    await env.plan('Implement restore.')
    expect((await env.records()).find(record => record.id === first?.id)?.outcome).toBe('unknown')
  })
  it('does not attribute verification performed before advice to a response to that advice', async () => {
    const env = await boot({ mode: 'assist', maxSteersPerTurn: 2 })
    await env.tool('write'); await env.tool('bash', { command: 'pnpm test', exitCode: 0 })
    await env.plan('Implement archive.')
    const first = (await env.records())[0]
    await env.plan('Implement restore.')
    expect((await env.records()).find(record => record.id === first?.id)?.outcome).toBe('unknown')
  })
  it('records a later verification result even after the steering budget is spent', async () => {
    const env = await boot({ mode: 'assist' })
    await env.plan('Implement archive.')
    const first = (await env.records())[0]
    await env.tool('write'); await env.tool('bash', { command: 'pnpm test', exitCode: 0 }); await env.step()
    expect((await env.records()).find(record => record.id === first?.id)?.outcome).toBe('check-passed')
  })
  it('does not inject weakly supported judgements', async () => {
    const env = await boot({ mode: 'assist' })
    env.jev.handler = () => Promise.resolve({ ...response, answers: { ...response.answers, justified: { type: 'noul', noul: 0.1 } } })
    expect(texts(await env.plan('Implement archive.'))).toBe('')
    expect(await env.records()).toMatchObject([{ action: 'continue', status: 'observed' }])
  })
  it('does not extend completion when another plugin already queued guidance', async () => {
    const env = await boot({ mode: 'assist' })
    await env.tool('write')
    env.queued.push(createUserMessage({ source: { kind: 'plugin', plugin: 'existing-check' }, content: [{ type: 'text', text: 'Existing verification guidance.' }] }))
    await env.stopping()
    expect(env.steered).toEqual([]); expect(env.jev.requests).toHaveLength(0)
  })
  it('serializes simultaneous pre-step checks for one owner', async () => {
    const env = await boot({ mode: 'assist' }); const waiting = deferred()
    env.jev.handler = () => waiting.promise
    const first = env.plan('Implement archive.')
    await expect.poll(() => env.jev.requests.length).toBe(1)
    expect(texts(await env.plan('Implement archive.'))).toBe('')
    waiting.resolve(response)
    await first
    expect(env.jev.requests).toHaveLength(1)
    expect(await env.records()).toHaveLength(1)
  })
  it('does not count a duplicated tool result as repeated failure', async () => {
    const env = await boot()
    await env.tool('bash', { command: 'pnpm test', exitCode: 1 }, 'same-call')
    await env.tool('bash', { command: 'pnpm test', exitCode: 1 }, 'same-call')
    await env.step()
    expect(env.jev.requests).toHaveLength(0)
  })
  it('ignores unowned and JEV tools but observes real tool execution failures', async () => {
    const env = await boot()
    await env.ctx.tools.execute({ name: 'write', arguments: {}, callId: ToolCallId('unowned-write'), signal: new AbortController().signal })
    await env.tool('jev_list', { fail: true }); await env.step()
    expect(env.jev.requests).toHaveLength(0)
    await env.tool('bash', { command: 'pnpm test', fail: true })
    await env.tool('bash', { command: 'pnpm test', fail: true })
    await env.step()
    expect(await env.records()).toMatchObject([{ event: 'repeated-failure' }])
  })
  it('records failed checks and later actions separately from verified acceptance', async () => {
    const env = await boot({ mode: 'assist', maxSteersPerTurn: 3 })
    await env.plan('Implement archive.')
    const first = (await env.records())[0]
    await env.tool('write'); await env.step()
    expect((await env.records()).find(record => record.id === first?.id)?.outcome).toBe('action-observed')
    const next = (await env.records()).find(record => record.id !== first?.id)
    await env.tool('bash', { command: 'pnpm test', exitCode: 1 }); await env.step()
    expect((await env.records()).find(record => record.id === next?.id)?.outcome).toBe('check-failed')
  })
  it.each(['node --test', 'node --test=archive.test.js', 'node --test archive.test.js'])('observes %s as an executed test command', async (command) => {
    const env = await boot({ mode: 'assist' })
    await env.plan('Implement archive with persistence.')
    const first = (await env.records())[0]
    await env.tool('write'); await env.tool('bash', { command, exitCode: 0 }); await env.step()
    expect((await env.records()).find(record => record.id === first?.id)?.outcome).toBe('check-passed')
  })
  it('does not call the provider when work tools are unavailable or the request is cancelled', async () => {
    const env = await boot(); const controller = new AbortController(); controller.abort()
    await env.plan('Implement archive.', controller.signal)
    for (const remove of env.removeTools) remove()
    await env.plan('Implement restore.')
    expect(env.jev.requests).toHaveLength(0)
  })
  it('skips sessions without a working directory', async () => {
    const env = await boot(); const id = SessionId('no-project')
    const agent = { ...env.agent, id, session: env.ctx.sessions.create(id) }
    await env.ctx.waterfall('agent/pre-step', { agent, turn: 1, step: 1, signal: new AbortController().signal,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement archive.' }] })],
    }, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    expect(env.jev.requests).toHaveLength(0)
  })
  it('honors cancellation triggered synchronously by the provider and accepts missing model metadata', async () => {
    const env = await boot({ mode: 'assist' }); const controller = new AbortController()
    env.jev.handler = () => { controller.abort(); return Promise.resolve(response) }
    expect(texts(await env.plan('Implement archive.', controller.signal))).toBe('')
    expect(await env.records()).toMatchObject([{ status: 'cancelled' }])
    env.jev.handler = () => Promise.resolve({ answers: response.answers })
    expect(texts(await env.plan('Implement archive.'))).toContain('focused check')
    expect((await env.records()).find(record => record.status === 'delivered')?.model).toBeUndefined()
  })
  it('does not deliver advice unless its delivery intent can be persisted', async () => {
    const env = await boot({ mode: 'assist' }); const dir = join(env.project, '.devflow', 'judgements', 'assistance')
    await mkdir(dir, { recursive: true })
    env.jev.handler = async () => { await chmod(dir, 0o500); return response }
    try { expect(texts(await env.plan('Implement archive.'))).toBe(''); expect(await env.records()).toEqual([]) }
    finally { await chmod(dir, 0o700) }
  })
  it('redacts credentials from the user task and tool observations before a remote judgement', async () => {
    const env = await boot()
    const secrets = ['quoted secret value', 'token-secret-value', 'sk-123456789012345678901234567890', 'ghp_123456789012345678901234567890', 'bearer-value', 'url-pass']
    const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-key-content\n-----END PRIVATE KEY-----'
    await env.tool('bash', { command: 'pnpm test --token=token-secret-value', exitCode: 1 })
    await env.plan(`Implement archive. {"api_key":"quoted secret value"} sk-123456789012345678901234567890 ghp_123456789012345678901234567890 Bearer bearer-value https://user:url-pass@example.test\n${privateKey}`)
    expect(env.jev.requests).toHaveLength(1)
    const transmitted = JSON.stringify(env.jev.requests)
    for (const secret of [...secrets, 'secret value', 'quoted secret', 'private-key-content']) expect(transmitted).not.toContain(secret)
    expect(transmitted).toContain('[redacted]')
  })
  it('leaves the existing workflow untouched when disabled', async () => {
    const env = await boot({ mode: 'off' })
    await env.plan('Implement archive.'); await env.tool('write'); await env.stopping()
    expect(env.jev.requests).toHaveLength(0); expect(await env.records()).toEqual([]); expect(env.steered).toEqual([])
  })
  it('binds exactly one successfully observed local card without changing its stage', async () => {
    const env = await boot()
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Archive', body: 'Persist archive and restore.', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    await env.tool('devflow_show', { id: created.card.id }); await env.plan('Implement archive.')
    expect(await env.records()).toMatchObject([{ card: { id: created.card.id, revision: 1, stage: 'draft' } }])
    expect((await env.ctx.devflow.read(created.card.id)).stageRevision).toBe(1)
  })
  it('keeps ambiguous and foreign-owned cards at session scope', async () => {
    const env = await boot()
    const first = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'First', body: 'First requirement.', by: { kind: 'human' } }))
    const second = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Second', body: 'Second requirement.', by: { kind: 'human' } }))
    if (!first.ok || !second.ok) throw new Error('fixture cards unavailable')
    await env.ctx.devflow.claim(first.card.id, { kind: 'agent', session: 'another-owner' })
    await env.tool('devflow_show', { id: first.card.id }); await env.plan('Implement archive.')
    expect((await env.records())[0]).toMatchObject({ associationReason: 'foreign-owner' })
    await env.tool('devflow_show', { id: second.card.id }); await env.plan('Implement restore.')
    expect((await env.records())[0]).toMatchObject({ associationReason: 'multiple-cards-observed' })
  })
  it('does not associate missing cards or unproven dispatched checkouts', async () => {
    const env = await boot()
    await mkdir(join(env.project, '.devflow'), { recursive: true })
    await env.tool('devflow_show', { id: '9999-missing' }); await env.plan('Implement archive.')
    expect((await env.records())[0]).toMatchObject({ associationReason: 'card-unavailable' })
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Dispatched', body: 'Implementation belongs in another checkout.', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    const artifact = await env.ctx.devflow.attachArtifact({ id: created.card.id, kind: 'worktree-dispatch', content: 'A different checkout.', expectedRevision: 1, by: { kind: 'human' } })
    if (!artifact.ok) throw new Error(artifact.message)
    await env.step('', new AbortController().signal, 2)
    await env.tool('devflow_show', { id: created.card.id })
    await env.plan('Implement restore.', new AbortController().signal, 2)
    expect((await env.records())[0]).toMatchObject({ associationReason: 'unverified-worktree' })
  })
  it('keeps unknown card identifiers session-scoped when the project has no board directory', async () => {
    const env = await boot()
    await rm(join(env.project, '.devflow'), { force: true, recursive: true })
    await env.tool('devflow_show', { id: '9999-missing' }); await env.tool('write'); await env.step('Implement archive.')
    expect((await env.records())[0]).toMatchObject({ associationReason: 'board-unavailable' })
    expect(env.jev.requests).toHaveLength(1)
  })
  it('associates a local card with a registered path-only artifact', async () => {
    const env = await boot()
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Archive', body: 'Persist archive status.', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    await mkdir(join(dirname(created.card.path), 'artifacts'), { recursive: true })
    await writeFile(join(dirname(created.card.path), 'artifacts', 'notes.md'), 'Acceptance: archive survives restart.')
    const attached = await env.ctx.devflow.attachArtifact({ id: created.card.id, path: 'artifacts/notes.md', expectedRevision: created.card.stageRevision, by: { kind: 'human' } })
    if (!attached.ok) throw new Error(attached.message)
    await env.tool('devflow_show', { id: created.card.id }); await env.plan('Implement archive.')
    expect((await env.records())[0]?.card?.id).toBe(created.card.id)
    expect(env.jev.requests[0]?.state).toContain('Acceptance: archive survives restart.')
  })
  it('redacts quoted secrets inside real card and artifact strings before JSON serialization', async () => {
    const env = await boot()
    const body = 'Persist archive status. Configuration example: {"api_key":"quoted secret value"}'
    const artifact = 'Acceptance: restart preserves archive. {"password":"artifact private value"}'
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Archive', body, by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    const attached = await env.ctx.devflow.attachArtifact({ id: created.card.id, kind: 'acceptance', content: artifact, expectedRevision: created.card.stageRevision, by: { kind: 'human' } })
    if (!attached.ok) throw new Error(attached.message)
    await env.tool('devflow_show', { id: created.card.id }); await env.plan('Implement archive.')
    expect((await env.records())[0]?.card?.id).toBe(created.card.id)
    expect(env.jev.requests).toHaveLength(1)
    const transmitted = JSON.stringify(env.jev.requests[0])
    for (const secret of ['quoted secret value', 'secret value', 'quoted secret', 'artifact private value', 'private value', 'artifact private']) expect(transmitted).not.toContain(secret)
    expect(transmitted).toContain('[redacted]')
    expect(transmitted).toContain('restart preserves archive')
    expect((await env.ctx.devflow.read(created.card.id)).body).toContain('quoted secret value')
  })
  it('does not associate an abandoned card with new development', async () => {
    const env = await boot()
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Abandoned', body: 'Old work.', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    const abandoned = await env.ctx.devflow.abandon({ id: created.card.id, expectedRevision: 1, by: { kind: 'human' }, reason: 'No longer requested.' })
    expect(abandoned.ok).toBe(true)
    await env.tool('devflow_show', { id: created.card.id }); await env.plan('Implement new archive behavior.')
    expect((await env.records())[0]).toMatchObject({ associationReason: 'inactive-card' })
  })
  it('does not associate a card whose reported root belongs to a different checkout', async () => {
    const env = await boot(); const outside = await boot()
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Archive', body: 'Persist archive.', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    const read = env.ctx.devflow.read.bind(env.ctx.devflow)
    vi.spyOn(env.ctx.devflow, 'read').mockImplementation(async (id, root) => ({ ...await read(id, root), root: outside.project }))
    await env.tool('devflow_show', { id: created.card.id }); await env.plan('Implement archive.')
    expect((await env.records())[0]).toMatchObject({ associationReason: 'unverified-worktree' })
    expect((await env.records())[0]?.card).toBeUndefined()
  })
  it('never transmits a card reached through another project symlink', async () => {
    const outside = await boot(); const env = await boot()
    const created = await outside.ctx.devflow.create(outside.ctx.devflow.resolveCreate({ title: 'External', body: 'EXTERNAL_REQUIREMENT_MUST_NOT_LEAVE_ITS_PROJECT', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    await rm(join(env.project, '.devflow'), { force: true, recursive: true })
    await symlink(join(outside.project, '.devflow'), join(env.project, '.devflow'))
    await env.tool('devflow_show', { id: created.card.id })
    expect(texts(await env.plan('Implement archive.'))).toBe('')
    expect(env.jev.requests).toHaveLength(0)
    expect(JSON.stringify(env.jev.requests)).not.toContain('EXTERNAL_REQUIREMENT_MUST_NOT_LEAVE_ITS_PROJECT')
    expect((await outside.ctx.devflow.read(created.card.id)).stageRevision).toBe(1)
    expect(await outside.records()).toEqual([])
  })
  it('accepts card identity from public nested or top-level tool output and ignores results without identity', async () => {
    const env = await boot()
    const created = await env.ctx.devflow.create(env.ctx.devflow.resolveCreate({ title: 'Archive', body: 'Persist archive.', by: { kind: 'human' } }))
    if (!created.ok) throw new Error(created.message)
    env.ctx.tools.register(defineTool({ name: 'devflow_create', description: 'card creation result fixture', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { card: { type: 'object', required: true, additionalProperties: false, properties: { id: { type: 'string', required: true } } } } }, render: () => [] },
      execute: () => Promise.resolve({ card: { id: created.card.id } }),
    }))
    env.ctx.tools.register(defineTool({ name: 'devflow_take', description: 'card claim result fixture', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true } } }, render: () => [] },
      execute: () => Promise.resolve({ id: created.card.id }),
    }))
    env.ctx.tools.register(defineTool({ name: 'devflow_read_artifact', description: 'artifact result fixture', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: () => [] },
      execute: () => Promise.resolve({ text: 'An artifact without a card identity.' }),
    }))
    await env.tool('devflow_read_artifact'); await env.plan('Implement archive.')
    expect((await env.records())[0]?.card).toBeUndefined()
    await env.tool('devflow_create'); await env.plan('Implement persistent archive.')
    expect((await env.records()).some(record => record.card?.id === created.card.id)).toBe(true)
    await env.step('', new AbortController().signal, 2)
    await env.tool('devflow_take'); await env.plan('Implement restore.', new AbortController().signal, 2)
    expect((await env.records()).filter(record => record.card?.id === created.card.id)).toHaveLength(2)
  })
  it('does not reinterpret non-text user or tool blocks as instructions', async () => {
    const env = await boot()
    const decision = await env.ctx.waterfall('agent/pre-step', { agent: env.agent, turn: 1, step: 1, signal: new AbortController().signal,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'reasoning', text: 'NON_TEXT_SHOULD_NOT_ENTER_JEV' }, { type: 'text', text: 'Implement archive.' }] })],
    }, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    expect(texts(decision)).toBe('')
    expect(JSON.stringify(env.jev.requests)).not.toContain('NON_TEXT_SHOULD_NOT_ENTER_JEV')
    env.ctx.tools.register(defineTool({ name: 'edit', description: 'non-text tool output fixture', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'reasoning', text: 'NON_TEXT_TOOL_SHOULD_NOT_ENTER_JEV' }] },
      execute: async () => { await writeFile(join(env.project, 'archive.ts'), 'export const archived = true\n'); return { ok: true } },
    }))
    await env.tool('edit'); await env.step()
    expect(env.jev.requests).toHaveLength(1)
    expect(JSON.stringify(env.jev.requests)).not.toContain('NON_TEXT_TOOL_SHOULD_NOT_ENTER_JEV')
  })
})
