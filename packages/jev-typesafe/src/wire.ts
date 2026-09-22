/**
 * Translation between the seam's vocabulary and the System One API's, plus the
 * mapping from the SDK's failure types onto {@link JevError} codes.
 *
 * Nothing here performs I/O, so the shapes the service actually sends and the
 * answers it actually accepts are testable from committed fixtures rather than
 * from a live endpoint.
 * @module @zhchxiao123/dsh-jev-typesafe/wire
 */

import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
} from '@typesafe-ai/sdk'
import type { EntryType, Questions as WireQuestions } from '@typesafe-ai/sdk'
import { JevError } from '@zhchxiao123/dsh-jev'
import type { Answer, Description, JevUsage, Question } from '@zhchxiao123/dsh-jev'

/**
 * Hand the state to the wire.
 *
 * The seam and the wire admit exactly the same values here — text, a JSON
 * object, a JSON array, or nothing. Only the `readonly` markers differ, and a
 * request is `readonly` in the seam because nothing may mutate it.
 *
 * @param state - the evidence this call evaluates.
 * @returns the same value, typed for the SDK.
 */
export function encodeState(state: Description): EntryType {
  return state as EntryType
}

/**
 * Render the seam's questions in the wire's shape.
 *
 * The seam's `Question` was defined to match this wire, so the translation is
 * a pass-through in every field. It exists as a function anyway because the
 * two types are owned by different packages, and a future divergence should
 * surface as a compile error in one place rather than at the call site.
 *
 * @param questions - the questions the caller asked.
 * @returns the same questions, typed for the SDK.
 */
export function encodeQuestions(questions: Readonly<Record<string, Question>>): WireQuestions {
  // One cast, at the one boundary that needs it: the seam marks a request
  // `readonly` because nothing may mutate it, and the SDK's input types are
  // simply not marked that way. The field names and value shapes are identical.
  return questions as unknown as WireQuestions
}

/**
 * Turn one wire answer into the seam's shape, or nothing when it cannot be
 * read as the answer its question asked for.
 *
 * Decoding is driven by the **question's** type rather than by guessing from
 * the payload's fields: a response missing a field then reads as "this one was
 * not answered", which the seam preserves as an absent key, instead of being
 * silently decoded as some other kind of answer.
 *
 * @param question - the question this answer belongs to.
 * @param raw - the answer as the API returned it.
 * @returns the decoded answer, or `undefined` when it cannot be read.
 */
export function decodeAnswer(question: Question, raw: unknown): Answer | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const payload = raw as Record<string, unknown>
  if (question.type === 'noul') {
    const noul = payload.noul
    return typeof noul === 'number' && Number.isFinite(noul) ? { type: 'noul', noul } : undefined
  }
  const confidence = payload.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return undefined
  if (question.type === 'score') {
    const score = payload.score
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
    return {
      type: 'score',
      score,
      confidence,
      probabilities: scoreProbabilities(payload.probabilities, question.criteria.length),
    }
  }
  const choice = payload.choice
  if (typeof choice !== 'string') return undefined
  return {
    type: 'choice',
    choice,
    confidence,
    probabilities: labelProbabilities(payload.probabilities),
  }
}

/**
 * Index a score distribution by level.
 *
 * The wire keys probabilities by score, so a level the model gave no weight may
 * simply be absent. Reading an absent level as zero is what an omitted entry in
 * a distribution means; it is not a value being invented.
 *
 * @param raw - the wire's `probabilities` object.
 * @param levels - how many levels the question defined.
 * @returns one probability per level, in level order.
 */
function scoreProbabilities(raw: unknown, levels: number): readonly number[] {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const probabilities: number[] = []
  for (let level = 0; level < levels; level += 1) {
    const value = source[String(level)]
    probabilities.push(typeof value === 'number' && Number.isFinite(value) ? value : 0)
  }
  return probabilities
}

/**
 * Keep the numeric entries of a label distribution.
 *
 * @param raw - the wire's `probabilities` object.
 * @returns probability per label; non-numeric entries are dropped.
 */
function labelProbabilities(raw: unknown): Readonly<Record<string, number>> {
  if (raw === null || typeof raw !== 'object') return {}
  const probabilities: Record<string, number> = {}
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) probabilities[label] = value
  }
  return probabilities
}

/**
 * Restate the wire's snake_case usage in the seam's vocabulary.
 *
 * @param raw - the wire's `usage` object.
 * @returns the usage, or `undefined` when the response carried none.
 */
export function decodeUsage(raw: unknown): JevUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const input = source.input_tokens
  const output = source.output_tokens
  const usage: { inputTokens?: number; outputTokens?: number } = {}
  if (typeof input === 'number' && Number.isFinite(input)) usage.inputTokens = input
  if (typeof output === 'number' && Number.isFinite(output)) usage.outputTokens = output
  return usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined : usage
}

/**
 * Classify a thrown value as the seam's failure vocabulary.
 *
 * The distinctions are the ones an operator acts on differently: a withdrawn
 * request is not a failure at all, a deadline is not an outage, a rate refusal
 * is not a wrong key, and a rejected key is not an unreachable service.
 *
 * @param error - whatever the SDK threw.
 * @returns the classified failure.
 */
export function classify(error: unknown): JevError {
  if (error instanceof JevError) return error
  if (error instanceof APIUserAbortError) {
    return new JevError('jev-typesafe: the request was withdrawn by its caller', 'JEV_ABORTED', { cause: error })
  }
  if (error instanceof APITimeoutError) {
    return new JevError(
      `jev-typesafe: no answer within ${String(error.timeoutMs)}ms`,
      'JEV_TIMEOUT',
      { cause: error },
    )
  }
  if (error instanceof RateLimitError) {
    return new JevError('jev-typesafe: rate limited, and retries were exhausted', 'JEV_RATE_LIMITED', { cause: error })
  }
  if (error instanceof APIError) {
    return new JevError(
      `jev-typesafe: the API answered HTTP ${String(error.status)}`,
      'JEV_HTTP_ERROR',
      { cause: error },
    )
  }
  // Everything left is a delivery failure: DNS, TLS, a closed connection, or a
  // proxy refusing the hop. `APIConnectionError` is the SDK's name for it, but
  // an unrecognized throw belongs in the same bucket rather than in a bucket
  // that claims to know more than we do.
  return new JevError(`jev-typesafe: the API could not be reached: ${describe(error)}`, 'JEV_UNAVAILABLE', { cause: error })
}

/**
 * Render a thrown value as a short message.
 *
 * @param error - the thrown value.
 * @returns its message, or its string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
