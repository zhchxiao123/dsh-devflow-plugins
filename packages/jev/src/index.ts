/**
 * Service Definition for the typed-judgement capability seam (`ctx.jev`). A
 * provider answers a {@link JevRequest} — one State plus a set of typed
 * Questions — with calibrated Answers that code thresholds directly, instead of
 * prose a caller has to parse.
 *
 * The seam holds the contract; providers hold only transport. Three invariants
 * live here rather than in each provider, because a provider that got one of
 * them wrong would be wrong quietly:
 *
 *   - answers are restricted to the keys that were asked;
 *   - an unanswered question stays absent, never present-and-empty;
 *   - failure throws {@link JevError}, so whether to fail open is the
 *     consumer's policy rather than the transport's.
 * @module @zhchxiao123/dsh-jev
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { JevError } from './errors.ts'
import type { Answer, JevRequest, JevResponse, Question } from './types.ts'

export type * from './types.ts'
export { JEV_ERROR_CODES, JevError } from './errors.ts'
export type { JevErrorCode } from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jev: JevRuntime
  }
}

/**
 * The largest option set one Choice may offer. A set past this size stops being
 * a choice and starts being a retrieval problem, which wants a different shape.
 */
const MAX_CHOICE_OPTIONS = 255

/** Every {@link Question} type the seam accepts. */
const QUESTION_TYPES = new Set(['choice', 'score', 'noul'])

/**
 * Reject a request the seam can already tell is unanswerable, before any
 * provider spends a call on it. The parameter is `unknown` because a request
 * reaching a plugin has whatever shape its caller gave it; typing it as
 * {@link JevRequest} would make each guard below look redundant to the linter
 * while leaving the real hole open.
 *
 * @param request - the candidate request.
 * @throws JevError with `JEV_INVALID_REQUEST` naming the offending question.
 */
export function assertRequest(request: unknown): asserts request is JevRequest {
  if (request === null || typeof request !== 'object') {
    throw new JevError('dsh-jev: request must be an object', 'JEV_INVALID_REQUEST')
  }
  const questions = (request as { questions?: unknown }).questions
  if (questions === null || typeof questions !== 'object') {
    throw new JevError('dsh-jev: request.questions must be an object', 'JEV_INVALID_REQUEST')
  }
  const entries = Object.entries(questions as Record<string, unknown>)
  if (entries.length === 0) {
    throw new JevError('dsh-jev: request.questions must hold at least one question', 'JEV_INVALID_REQUEST')
  }
  for (const [id, question] of entries) assertQuestion(id, question)
}

/**
 * Validate one question against the shape its own type promises.
 *
 * @param id - the key this question was asked under, for the message.
 * @param question - the candidate question.
 * @throws JevError with `JEV_INVALID_REQUEST`.
 */
function assertQuestion(id: string, question: unknown): void {
  if (question === null || typeof question !== 'object') {
    throw new JevError(`dsh-jev: question "${id}" must be an object`, 'JEV_INVALID_REQUEST')
  }
  const { type, criteria } = question as { type?: unknown; criteria?: unknown }
  if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) {
    throw new JevError(
      `dsh-jev: question "${id}" has type ${JSON.stringify(type)}; expected "choice", "score", or "noul"`,
      'JEV_INVALID_REQUEST',
    )
  }
  if (type === 'score') {
    // Two is the floor, not one: a rubric with a single level has nothing to
    // discriminate, so every answer would be that level and the question would
    // carry no information.
    if (!Array.isArray(criteria) || criteria.length < 2) {
      throw new JevError(
        `dsh-jev: score question "${id}" needs at least two criteria levels; its levels are what a score means`,
        'JEV_INVALID_REQUEST',
      )
    }
    return
  }
  if (type === 'choice') {
    if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new JevError(
        `dsh-jev: choice question "${id}" needs a criteria object mapping each option to its rubric`,
        'JEV_INVALID_REQUEST',
      )
    }
    const options = Object.keys(criteria).length
    if (options === 0) {
      throw new JevError(`dsh-jev: choice question "${id}" needs at least one option`, 'JEV_INVALID_REQUEST')
    }
    if (options > MAX_CHOICE_OPTIONS) {
      throw new JevError(
        `dsh-jev: choice question "${id}" offers ${options} options; at most ${MAX_CHOICE_OPTIONS} are allowed`,
        'JEV_INVALID_REQUEST',
      )
    }
  }
}

/**
 * Project a provider's answers onto the keys that were actually asked.
 *
 * Purely subtractive: an answer to a question nobody asked is dropped, and a
 * question with no answer is left out rather than filled in. Inventing a value
 * here would erase the difference between a judgement of zero and no judgement.
 *
 * @param questions - the questions the caller asked.
 * @param answers - whatever the provider returned.
 * @returns the answers restricted to asked keys.
 */
export function retainAsked(
  questions: Readonly<Record<string, Question>>,
  answers: Readonly<Record<string, Answer>>,
): Readonly<Record<string, Answer>> {
  const retained: Record<string, Answer> = {}
  for (const id of Object.keys(questions)) {
    const answer = answers[id]
    if (answer !== undefined) retained[id] = answer
  }
  return retained
}

/**
 * The typed-judgement seam. A provider subclasses this and implements
 * {@link JevRuntime.perform}; the provider's own plugin row is what registers
 * `ctx.jev`, so a composition mounts the provider and not this class.
 */
export abstract class JevRuntime extends Service {
  /**
   * @param ctx - the context this service is registered on.
   */
  constructor(ctx: Context) {
    super(ctx, 'jev')
  }

  /**
   * Ask one State a set of typed Questions.
   *
   * @param request - the State and the Questions asked against it.
   * @param signal - cancellation for this call.
   * @returns answers under the keys they were asked under.
   * @throws JevError for every failure, including cancellation
   *   (`JEV_ABORTED`), which callers must re-raise rather than treat as an
   *   unavailable judgement.
   */
  async ask(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    if (signal?.aborted === true) {
      throw new JevError('dsh-jev: request was aborted before it was sent', 'JEV_ABORTED')
    }
    assertRequest(request)
    const raw = await this.perform(request, signal)
    return { ...raw, answers: retainAsked(request.questions, raw.answers) }
  }

  /**
   * Transport. Called only with a request {@link JevRuntime.ask} has already
   * validated, and its answers are projected afterwards, so an implementation
   * owns encoding, the call itself, decoding, and failure classification —
   * and nothing about the contract.
   *
   * @param request - the validated request.
   * @param signal - cancellation for this call.
   * @returns the provider's answers, before projection.
   */
  protected abstract perform(request: JevRequest, signal?: AbortSignal): Promise<JevResponse>
}

export default JevRuntime
