/* oxlint-disable @stylistic/max-len */
import type { JevRuntime } from './index.ts'
import { JEV_ERROR_CODES } from './errors.ts'
import type { JevErrorCode } from './errors.ts'
import type { JevRequest, JevResponse, JsonValue } from './types.ts'

export interface JevRunSubject { readonly kind: string; readonly id: string; readonly title: string; readonly metadata?: Readonly<Record<string, JsonValue>> }
export interface JevRunTemplate { readonly id: string; readonly version: string }
export interface JevRunCheck { readonly id: string; readonly subject: JevRunSubject; readonly evidenceDigest: string; readonly request: JevRequest }
export interface JevRunDefinition {
  readonly id: string
  readonly scope: JevRunSubject
  readonly template: JevRunTemplate
  readonly createdAt: string
  readonly checks: readonly JevRunCheck[]
  /**
   * Deadline per check. A check past it records a `JEV_TIMEOUT` failure and
   * the run moves on, so one hanging judgement bounds itself instead of
   * holding the whole run in `running` — the window in which a process
   * restart turns the run into `interrupted`.
   */
  readonly checkTimeoutMs?: number
}
export type JevRunStatus = 'planned' | 'running' | 'completed' | 'completed-with-errors' | 'cancelled' | 'interrupted'
export interface JevRunResult { readonly checkId: string; readonly subject: JevRunSubject; readonly evidenceDigest: string; readonly status: 'completed' | 'failed'; readonly response?: JevResponse; readonly error?: { readonly code: JevErrorCode; readonly message: string }; readonly completedAt: string }
export interface JevRunState { readonly runId: string; readonly status: JevRunStatus; readonly total: number; readonly completed: number; readonly failed: number; readonly results: readonly JevRunResult[]; readonly createdAt: string; readonly startedAt?: string; readonly finishedAt?: string; readonly jobId?: string }
export interface JevRunHooks { readonly validate?: (check: JevRunCheck) => void | Promise<void>; readonly onResult?: (result: JevRunResult, state: JevRunState) => void | Promise<void>; readonly onState?: (state: JevRunState) => void | Promise<void> }

export function initialJevRunState(definition: JevRunDefinition): JevRunState { return { runId: definition.id, status: 'planned', total: definition.checks.length, completed: 0, failed: 0, results: [], createdAt: definition.createdAt } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function code(error: unknown): JevErrorCode { const value: unknown = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined; return typeof value === 'string' && JEV_ERROR_CODES.includes(value as JevErrorCode) ? value as JevErrorCode : 'JEV_UNAVAILABLE' }
function aborted(signal?: AbortSignal): boolean { return signal?.aborted === true }

/** Domain-neutral orchestration for a durable set of typed judgements. Adapters own evidence collection, interpretation, and persistence. */
export class JevRunEngine {
  private readonly active = new Set<string>()
  constructor(private readonly runtime: JevRuntime) {}

  isActive(runId: string): boolean { return this.active.has(runId) }

  recover(state: JevRunState, activity: { readonly active?: boolean; readonly jobBound?: boolean } = {}): JevRunState {
    const active = activity.active ?? this.active.has(state.runId)
    const orphaned = state.status === 'running' || state.status === 'planned'
    if (!orphaned || active) return state
    return { ...state, status: 'interrupted', finishedAt: new Date().toISOString() }
  }

  async run(definition: JevRunDefinition, previous?: JevRunState, hooks: JevRunHooks = {}, signal?: AbortSignal): Promise<JevRunState> {
    if (new Set(definition.checks.map(check => check.id)).size !== definition.checks.length) throw new Error('dsh-jev: run check ids must be unique')
    if (definition.checkTimeoutMs !== undefined && (!Number.isFinite(definition.checkTimeoutMs) || definition.checkTimeoutMs <= 0)) throw new Error('dsh-jev: checkTimeoutMs must be a positive finite number')
    if (this.active.has(definition.id)) throw new Error(`dsh-jev: run ${definition.id} is already active`)
    this.active.add(definition.id)
    try {
      const retained = (previous?.results ?? []).filter(result => result.status === 'completed' && definition.checks.some(check => check.id === result.checkId && check.evidenceDigest === result.evidenceDigest))
      let state: JevRunState = { ...(previous ?? initialJevRunState(definition)), status: 'running', total: definition.checks.length, completed: retained.length, failed: 0, results: retained, startedAt: previous?.startedAt ?? new Date().toISOString() }
      const done = new Set(retained.map(result => result.checkId)); await hooks.onState?.(state)
      let cancelled = false
      for (const check of definition.checks) {
        if (aborted(signal)) break
        if (done.has(check.id)) continue
        let result: JevRunResult
        try {
          await hooks.validate?.(check)
          const response = await this.ask(check.request, signal, definition.checkTimeoutMs)
          result = { checkId: check.id, subject: check.subject, evidenceDigest: check.evidenceDigest, status: 'completed', response, completedAt: new Date().toISOString() }
        } catch (error: unknown) {
          if (aborted(signal) || (code(error) === 'JEV_ABORTED' && definition.checkTimeoutMs === undefined)) { cancelled = true; break }
          // With a deadline configured and the run signal quiet, an abort here
          // is this check's own deadline; the caller's cancellation keeps its
          // meaning through the run signal.
          result = code(error) === 'JEV_ABORTED'
            ? { checkId: check.id, subject: check.subject, evidenceDigest: check.evidenceDigest, status: 'failed', error: { code: 'JEV_TIMEOUT', message: `the check deadline of ${String(definition.checkTimeoutMs)}ms elapsed` }, completedAt: new Date().toISOString() }
            : { checkId: check.id, subject: check.subject, evidenceDigest: check.evidenceDigest, status: 'failed', error: { code: code(error), message: message(error) }, completedAt: new Date().toISOString() }
        }
        state = { ...state, completed: state.completed + 1, failed: state.failed + (result.status === 'failed' ? 1 : 0), results: [...state.results, result] }
        await hooks.onResult?.(result, state); await hooks.onState?.(state)
      }
      state = cancelled || aborted(signal) ? { ...state, status: 'cancelled', finishedAt: new Date().toISOString() } : { ...state, status: state.failed > 0 ? 'completed-with-errors' : 'completed', finishedAt: new Date().toISOString() }
      await hooks.onState?.(state); return state
    } finally { this.active.delete(definition.id) }
  }

  private async ask(request: JevRequest, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<JevResponse> {
    if (timeoutMs === undefined) return this.runtime.ask(request, signal)
    const control = new AbortController()
    const cancel = () => { control.abort() }
    signal?.addEventListener('abort', cancel, { once: true })
    if (aborted(signal)) control.abort()
    const timer = setTimeout(cancel, timeoutMs)
    try {
      return await this.runtime.ask(request, control.signal)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}
