/* oxlint-disable @stylistic/max-len */
/** Observe the current Harness agent and offer bounded advice, never execute development work. */
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevCard } from '@zhchxiao123/dsh-devflow'
import { collectEvidence } from './evidence.ts'
import { collectWorkspaceEvidence } from './workspace-evidence.ts'
import { AssistanceStore } from './assistance-store.ts'
import { assistanceDecision, assistanceRequest, ASSISTANCE_POLICY_VERSION } from './assistance-policy.ts'
import type { AssistanceCard, AssistanceConfig, AssistanceEvent, AssistanceRecord } from './assistance-types.ts'

declare module '@deepseek-ai/cordis' { interface Context { devflowAssistance: DevflowAssistance } }
interface Observation {
  turn: number
  calls: number
  steers: number
  version: number
  active: boolean
  task: string
  dirty: boolean
  planning: boolean
  pending: boolean
  cards: Set<string>
  seen: Set<string>
  outcomes: string[]
  failure: string
  repeats: number
  latestCheck: { passed: boolean; sequence: number; name: string; callId: string; exitCode: number } | undefined
  lastExecution?: { name: string; callId: string; exitCode?: number }
  lastAction: number
  checkSequence: number
  delivered?: { id: string; version: number; checkSequence: number; observedVersion?: number }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function cancelled(signal: AbortSignal): boolean { return signal.aborted }
/** Bound providers which do not settle promptly after abort; consume their late rejection. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new Error('assistance aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}
function prompt(record: AssistanceRecord): UserMessage {
  return createUserMessage({ source: { kind: 'plugin', plugin: 'devflow-jev' }, content: [{ type: 'text', text: `JEV development assistance (${record.id}): ${record.reason}\nUse current evidence to decide the next step. This is advice, not proof of a bug, a passing test, or permission to bypass workflow gates. Coverage gaps: ${record.gaps.join('; ')}.` }] })
}
function object(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
/** Best-effort removal of conventional credentials; raw tool payloads are never persisted. */
function safeText(value: string, cap: number): string {
  return value
    .replace(/(?:Bearer\s+\S+|(?:api[_-]?key|token|password|secret|authorization)["']?\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}]+))/gi, '[redacted]')
    .replace(/\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{16,}|xox[baprs]-[a-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gi, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/https?:\/\/[^\s/:]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .slice(0, cap)
}
const WORK_TOOLS = ['read', 'bash', 'edit', 'write']
const CARD_TOOLS = new Set(['devflow_create', 'devflow_show', 'devflow_take', 'devflow_transition', 'devflow_attach_artifact', 'devflow_read_artifact'])
const CHANGE_TOOLS = new Set(['write', 'edit', 'apply_patch'])

export class DevflowAssistance extends Service {
  static inject = ['devflow', 'jev', 'tools']
  private readonly records = new AssistanceStore()
  private readonly observations = new WeakMap<Agent, Observation>()
  private readonly shutdown = new AbortController()
  constructor(ctx: Context, readonly config: AssistanceConfig) {
    super(ctx, 'devflowAssistance')
    ctx.effect(() => () => { this.shutdown.abort() })
    if (config.mode === 'off') return
    ctx.on('tools/result', (exec, result) => { this.observe(exec, result) })
    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || signal.aborted) return decision
      const state = this.state(agent, turn)
      const incoming = messages.filter(message => message.source.kind !== 'plugin' && message.source.kind !== 'tool').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      if (incoming.trim() !== '') {
        state.task = safeText(incoming, this.config.maxFileBytes)
        state.planning = /implement|fix|develop|feature|refactor|test|bug|实现|开发|修复|需求|功能|测试|重构/i.test(incoming)
      }
      const additions: UserMessage[] = []
      await this.check(agent, state, state.repeats >= config.repeatThreshold ? 'repeated-failure' : state.planning ? 'planning' : 'changed-code', signal, (message) => { additions.push(message) })
      return additions.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...additions] }
    })
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      const state = this.state(agent, turn)
      if (!state.dirty || agent.inbox.nextStep.length > 0) return
      await this.check(agent, state, 'completion', signal, (message) => { agent.steer(message) })
    })
  }
  list(project: string): Promise<AssistanceRecord[]> { return this.records.list(project) }
  read(project: string, id: string): Promise<AssistanceRecord> { return this.records.read(project, id) }
  private state(agent: Agent, turn?: number): Observation {
    let state = this.observations.get(agent)
    if (state === undefined) {
      state = { turn: turn ?? 0, calls: 0, steers: 0, version: 0, active: false, task: '', dirty: false, planning: false, pending: false, cards: new Set(), seen: new Set(), outcomes: [], failure: '', repeats: 0, latestCheck: undefined, lastAction: 0, checkSequence: 0 }
      this.observations.set(agent, state)
    }
    if (turn !== undefined && state.turn !== turn) {
      state.turn = turn; state.calls = 0; state.steers = 0; state.cards.clear(); state.seen.clear()
      state.outcomes = []; state.repeats = 0; state.failure = ''; state.latestCheck = undefined
    }
    return state
  }
  private observe(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (exec.agent === undefined || exec.name.startsWith('jev_') || exec.name === 'devflow_assess' || exec.name === 'run_code') return
    const state = this.state(exec.agent)
    const call = String(exec.callId)
    if (state.seen.has(call)) return
    state.seen.add(call)
    const args = object(exec.arguments); const value = object(result.value)
    if (CARD_TOOLS.has(exec.name) && !result.isError) {
      const id = args?.id ?? value?.id ?? object(value?.card)?.id
      if (typeof id === 'string') { state.cards.add(id); state.pending = true; state.version++ }
    }
    const command = typeof args?.command === 'string' ? args.command : ''
    const check = exec.name === 'bash' && /(?:^|[\s/])(?:test|pytest|vitest|jest|check|typecheck|lint)(?:\b|:)|(?:^|\s)node\s+[^\n]*--test(?:[=\s]|$)/i.test(command)
    const failed = result.isError || (typeof value?.exitCode === 'number' && value.exitCode !== 0)
    if (exec.name === 'bash' || CHANGE_TOOLS.has(exec.name) || failed) {
      state.version++; state.pending = true
      state.lastExecution = { name: exec.name, callId: call, ...(typeof value?.exitCode === 'number' ? { exitCode: value.exitCode } : {}) }
      if (CHANGE_TOOLS.has(exec.name) && !failed) { state.dirty = true; state.lastAction = state.version; state.latestCheck = undefined }
      if (exec.name === 'bash') { state.dirty = true; state.lastAction = state.version }
      const signature = hash(JSON.stringify([exec.name, exec.arguments]))
      if (failed) { state.repeats = state.failure === signature ? state.repeats + 1 : 1; state.failure = signature }
      else if (check) { state.repeats = 0; state.failure = '' }
      if (check && typeof value?.exitCode === 'number') { state.checkSequence++; state.latestCheck = { passed: !failed, sequence: state.checkSequence, name: exec.name, callId: call, exitCode: value.exitCode } }
      const output = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      state.outcomes.push(safeText(`${exec.name}: ${command}\n${failed ? 'failed' : check ? 'check completed' : 'tool completed'}\n${output}`, this.config.maxFileBytes))
      state.outcomes = state.outcomes.slice(-this.config.maxFiles)
    }
  }
  private async binding(agent: Agent, state: Observation, project: string): Promise<{ card?: AssistanceCard; task: string; digest: string }> {
    if (state.cards.size !== 1) return { task: state.task, digest: hash(state.task) }
    // The single observed card is fixed by the size check before any await.
    const id = [...state.cards][0] as string
    const root = join(project, '.devflow')
    let actualRoot: string
    try { actualRoot = await realpath(root) }
    catch { return { task: state.task, digest: hash(state.task) } }
    if (actualRoot !== root) return { task: state.task, digest: hash(state.task) }
    let card: DevCard
    try { card = await this.ctx.devflow.read(DevflowCardId(id), root) }
    catch { return { task: state.task, digest: hash(state.task) } }
    const holder = await this.ctx.devflow.holder(card.id, root)
    if (holder !== undefined && (holder.owner.kind !== 'agent' || holder.owner.session !== agent.session.id)) return { task: state.task, digest: hash(state.task) }
    if (await realpath(card.root) !== await realpath(root) || card.archived || card.abandoned) return { task: state.task, digest: hash(state.task) }
    // A dispatched card can only be associated after its actual checkout is proved.
    if (card.artifactRecords.some(record => /worktree|dispatch/.test(record.kind ?? ''))) return { task: state.task, digest: hash(state.task) }
    const board = await this.ctx.devflow.list(undefined, root)
    const evidence = await collectEvidence(root, card, board, await this.ctx.devflow.history(card.id, root))
    return { card: { id: card.id, revision: card.stageRevision, stage: card.stage, title: card.title }, task: JSON.stringify(evidence, (_key, value: unknown) => typeof value === 'string' ? safeText(value, this.config.maxBytes) : value).slice(0, this.config.maxBytes), digest: hash(JSON.stringify(evidence)) }
  }
  private async check(agent: Agent, state: Observation, event: AssistanceEvent, outerSignal: AbortSignal, deliver: (message: UserMessage) => void): Promise<void> {
    if (state.active || (!state.pending && !state.planning && event !== 'completion') || outerSignal.aborted || this.shutdown.signal.aborted) return
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const available = WORK_TOOLS.filter(name => this.ctx.tools.get(name, agent) !== undefined)
    if (available.length === 0) return
    state.active = true
    const controller = new AbortController()
    const signal = AbortSignal.any([outerSignal, controller.signal, this.shutdown.signal])
    const timer = setTimeout(() => { controller.abort() }, this.config.timeoutMs)
    const started = Date.now(); const version = state.version
    let record: AssistanceRecord | undefined; let project = cwd
    try {
      project = await realpath(cwd)
      const workspace = await collectWorkspaceEvidence(project, { maxBytes: this.config.maxBytes, maxFiles: this.config.maxFiles, maxFileBytes: this.config.maxFileBytes, timeoutMs: this.config.timeoutMs }, signal)
      const bound = await this.binding(agent, state, project)
      const digest = hash(JSON.stringify([workspace.digest, bound.digest, state.outcomes, state.task]))
      const prior = (await this.list(project)).filter(item => item.sessionId === agent.session.id)
      const delivered = state.delivered
      const previous = prior.find(item => item.id === delivered?.id && item.status === 'delivered')
      if (previous !== undefined && delivered !== undefined && state.lastAction > (delivered.observedVersion ?? delivered.version)) {
        const check = state.latestCheck !== undefined && state.latestCheck.sequence > delivered.checkSequence ? state.latestCheck : undefined
        const observed = check ?? state.lastExecution
        await this.records.write(project, { ...previous, outcome: check === undefined ? 'action-observed' : check.passed ? 'check-passed' : 'check-failed', outcomeDetail: `Later tool ${observed?.name} (call ${observed?.callId}, exit ${observed?.exitCode ?? 'unknown'}) was observed; causality and full requirement coverage are not established.`, updatedAt: new Date().toISOString() })
        delivered.observedVersion = state.lastAction
      }
      if (!state.planning && workspace.status.trim() === '' && state.repeats < this.config.repeatThreshold) { state.pending = false; state.dirty = false; return }
      state.calls = Math.max(state.calls, prior.filter(item => item.turn === state.turn && item.status !== 'budget-exhausted').length)
      state.steers = Math.max(state.steers, prior.filter(item => item.turn === state.turn && ['delivering', 'delivered'].includes(item.status)).length)
      // Preserve a final evidence check instead of spending every call during implementation.
      if (this.config.maxCallsPerTurn > 1 && state.calls >= this.config.maxCallsPerTurn - 1 && event !== 'completion' && event !== 'repeated-failure') return
      const now = new Date().toISOString()
      record = { id: randomUUID(), workspace: project, sessionId: agent.session.id, turn: state.turn, ...bound.card === undefined ? {} : { card: bound.card }, event, mode: this.config.mode, evidenceDigest: digest, policyVersion: ASSISTANCE_POLICY_VERSION, action: 'continue', reason: '', evidenceRefs: [], gaps: [...workspace.gaps], confidence: 0, status: 'observed', outcome: 'unknown', elapsedMs: 0, createdAt: now, updatedAt: now }
      const providerIdentity = this.ctx.jev.configurationIdentity()
      const configurationStatus = await abortable(this.ctx.jev.configurationStatus(), signal)
      record = { ...record, configurationStatus, ...(providerIdentity === undefined ? {} : { providerIdentity }) }
      if (prior.some(item => item.evidenceDigest === digest && item.event === event && item.policyVersion === ASSISTANCE_POLICY_VERSION && item.providerIdentity === providerIdentity
        && (['delivering', 'delivered'].includes(item.status) || (item.mode === this.config.mode && item.configurationStatus === configurationStatus && (['observed', 'unavailable'].includes(item.status) || (item.status === 'budget-exhausted' && item.turn === state.turn)))))) { record = undefined; state.pending = false; state.planning = false; if (event === 'completion') state.dirty = false; return }
      if (state.calls >= this.config.maxCallsPerTurn) { record = { ...record, status: 'budget-exhausted', reason: 'The per-turn judgement budget is exhausted.' }; return }
      state.calls++
      if (configurationStatus !== 'configured') { record = { ...record, status: 'unavailable', reason: 'The judgement credential is unavailable or unverified locally.' }; return }
      signal.throwIfAborted()
      const response = await abortable(this.ctx.jev.ask(assistanceRequest(event, bound.task || state.task, workspace, state.outcomes, available), signal), signal)
      signal.throwIfAborted()
      const decision = assistanceDecision(response, workspace, this.config.confidenceFloor, bound.task || state.task, state.outcomes)
      record = { ...record, ...decision, ...(response.model === undefined ? {} : { model: response.model }), ...response.usage }
      const fresh = await collectWorkspaceEvidence(project, { maxBytes: this.config.maxBytes, maxFiles: this.config.maxFiles, maxFileBytes: this.config.maxFileBytes, timeoutMs: this.config.timeoutMs }, signal)
      const current = await this.binding(agent, state, project)
      if (this.ctx.jev.configurationIdentity() !== providerIdentity || version !== state.version || fresh.digest !== workspace.digest || current.digest !== bound.digest || agent.session.header.cwd !== cwd || available.some(name => this.ctx.tools.get(name, agent) === undefined)) { record = { ...record, status: 'stale', reason: 'Evidence, ownership, or available tools changed before advice could be delivered.' }; return }
      if (this.config.mode === 'assist' && decision.action !== 'continue') {
        if (state.steers >= this.config.maxSteersPerTurn || (event === 'completion' && agent.inbox.nextStep.length > 0)) { record = { ...record, status: 'budget-exhausted' }; return }
        record = { ...record, status: 'delivering' }
        await this.records.write(project, record)
        signal.throwIfAborted()
        state.steers++
        deliver(prompt(record))
        record = { ...record, status: 'delivered' }
        state.delivered = { id: record.id, version: state.version, checkSequence: state.checkSequence }
      }
    } catch {
      // Provider and filesystem errors may embed credentials or source text; persist only a safe category.
      if (record !== undefined) record = { ...record, status: cancelled(outerSignal) || cancelled(this.shutdown.signal) ? 'cancelled' : 'unavailable', reason: controller.signal.aborted ? 'Assistance timed out; normal workflow remains in control.' : 'Assistance could not complete; no acceptance verdict was produced.' }
    } finally {
      clearTimeout(timer)
      state.active = false; state.pending = state.version !== version; state.planning = false
      if (event === 'completion' && state.version === version) state.dirty = false
      if (record !== undefined) {
        await this.records.write(project, { ...record, elapsedMs: Date.now() - started, updatedAt: new Date().toISOString() }).catch(() => { this.ctx.logger.warn('devflow-jev: assistance record could not be persisted') })
      }
    }
  }
}
