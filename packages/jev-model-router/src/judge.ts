/**
 * Turning one pending delegation into a tier.
 *
 * The rule this module exists to hold: a judgement that did not arrive never
 * blocks a delegation. Routing is a cost and capability decision, not a safety
 * gate, so every way of failing to judge — a missing credential, this router's
 * own deadline, a malformed answer, an answer that never came — resolves to
 * "unavailable" and lets the dispatch proceed on whatever the model picked.
 *
 * The one failure that is NOT unavailable is the caller withdrawing the
 * request. Reporting a cancelled dispatch as a routing outcome would render a
 * user's interrupt as a model mistake.
 * @module @zhchxiao123/dsh-jev-model-router/judge
 */

import { JevError } from '@zhchxiao123/dsh-jev'
import type { JevRuntime, Question } from '@zhchxiao123/dsh-jev'
import type { ResolvedConfig, ResolvedTier } from './config.ts'

/** The key the routing question is asked under. */
export const QUESTION_KEY = 'tier'

/**
 * Characters of the delegated prompt that reach the judgement. A delegation
 * prompt is unbounded, and the opening of one says what kind of work it is;
 * this is not a budget a deployment tunes, because a tier that depended on how
 * much of the prompt was read would not be reproducible.
 */
export const MAX_PROMPT_CHARS = 8000

/** How the judgement is framed. */
export const SCORE_INSTRUCTION =
  'How much model capability does this delegated task need to be done well? '
  + 'Rate the task itself, not how it is worded: how much reading, reasoning, and '
  + 'care across files it takes, and how costly a wrong result would be.'

/** Abort reason marking this router's own deadline, not the caller's. */
const DEADLINE = Symbol('jev-model-router judgement deadline')

/**
 * Read a signal's current state.
 *
 * Through a call rather than inline: an early return on `signal.aborted`
 * narrows it to `false` for the rest of the function, and a signal that aborts
 * during an await would then be read as the stale narrowing.
 *
 * @param signal - the signal to read.
 * @returns whether it has been aborted by now.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** What a pending delegation offers as evidence. */
export interface Delegation {
  /** The delegation's short description, when it carried one. */
  readonly description?: string
  /** The prompt the child receives. */
  readonly prompt: string
  /** The delegating parent's own route, when it is known. */
  readonly parentRoute?: string
}

/** What one routing judgement concluded. */
export type Judgement =
  /** The tier this delegation warrants. */
  | { readonly kind: 'tier'; readonly index: number; readonly score: number; readonly confidence: number }
  /** No usable judgement; the dispatch proceeds unrouted. */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** The caller withdrew the dispatch; this is not a routing outcome. */
  | { readonly kind: 'withdrawn' }

/**
 * Build the shared evidence.
 *
 * @param delegation - the pending delegation.
 * @returns the State one routing question is answered against.
 */
export function buildState(delegation: Delegation): Record<string, string> {
  const prompt = delegation.prompt.length > MAX_PROMPT_CHARS
    ? `${delegation.prompt.slice(0, MAX_PROMPT_CHARS)}\n... (truncated)`
    : delegation.prompt
  return {
    task: 'Subagent delegation routing',
    ...delegation.description === undefined ? {} : { description: delegation.description },
    ...delegation.parentRoute === undefined ? {} : { delegatingParentRoute: delegation.parentRoute },
    delegatedPrompt: prompt,
  }
}

/**
 * Build the routing question. The tiers ARE the rubric, so a tier's own
 * description is the only place its level is defined.
 *
 * @param tiers - the configured tiers, weakest first.
 * @returns the Score question.
 */
export function buildQuestion(tiers: readonly ResolvedTier[]): Question {
  return {
    type: 'score',
    instructions: SCORE_INSTRUCTION,
    criteria: tiers.map(tier => tier.when) as unknown as [string, string, ...string[]],
  }
}

/**
 * Turn a score into a tier index.
 *
 * The score is probability-weighted, so it can land between levels. A value
 * exactly halfway rounds UP: under-provisioning a hard task costs a wrong
 * result, while over-provisioning costs money, and those are not the same
 * mistake.
 *
 * @param score - the judged position among the tiers.
 * @param count - how many tiers there are.
 * @returns an index inside the tier list.
 */
export function tierIndexOfScore(score: number, count: number): number {
  return Math.min(Math.max(Math.round(score), 0), count - 1)
}

/**
 * Judge one delegation.
 *
 * @param jev - the judgement seam.
 * @param delegation - the pending delegation's evidence.
 * @param config - the tiers and this router's own deadline.
 * @param callerSignal - the dispatch's cancellation, which is NOT this
 *   router's deadline and must stay distinguishable from it.
 * @returns the tier, or why there is none.
 */
export async function judge(
  jev: JevRuntime,
  delegation: Delegation,
  config: ResolvedConfig,
  callerSignal: AbortSignal,
): Promise<Judgement> {
  if (callerSignal.aborted) return { kind: 'withdrawn' }

  // One controller fused from two independent reasons to stop. Which of them
  // fired is read back from `callerSignal` rather than from the error, because
  // both arrive as the same `JEV_ABORTED` code.
  const controller = new AbortController()
  const relay = (): void => { controller.abort(callerSignal.reason) }
  callerSignal.addEventListener('abort', relay, { once: true })
  // A provider reports every abort as its own `JEV_ABORTED`, so the reason the
  // call stopped is carried by what stopped it rather than read off the error.
  const expire = setTimeout(() => { controller.abort(DEADLINE) }, config.judgeTimeoutMs)

  try {
    const response = await jev.ask({
      state: buildState(delegation),
      questions: { [QUESTION_KEY]: buildQuestion(config.tiers) },
    }, controller.signal)
    const answer = response.answers[QUESTION_KEY]
    // The seam leaves an unanswered question absent rather than filling it in,
    // which is the whole reason "not judged" is distinguishable here.
    if (answer === undefined) return { kind: 'unavailable', reason: 'the judgement returned no answer for the routing question' }
    if (answer.type !== 'score') return { kind: 'unavailable', reason: `the judgement answered with a ${answer.type}, not a score` }
    if (!Number.isFinite(answer.score)) return { kind: 'unavailable', reason: 'the judgement returned a score that is not a finite number' }
    return {
      kind: 'tier',
      index: tierIndexOfScore(answer.score, config.tiers.length),
      score: answer.score,
      confidence: answer.confidence,
    }
  } catch (error: unknown) {
    // Order matters: the caller's withdrawal outranks this router's deadline,
    // because a dispatch the user stopped has no routing outcome at all.
    if (isAborted(callerSignal)) return { kind: 'withdrawn' }
    if (controller.signal.reason === DEADLINE) {
      return { kind: 'unavailable', reason: `the judgement exceeded judgeTimeoutMs (${String(config.judgeTimeoutMs)}ms)` }
    }
    const reason = error instanceof JevError ? `${error.code}: ${error.message}` : String(error)
    return { kind: 'unavailable', reason }
  } finally {
    clearTimeout(expire)
    callerSignal.removeEventListener('abort', relay)
  }
}
