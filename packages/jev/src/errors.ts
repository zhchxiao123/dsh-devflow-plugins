/**
 * Failure vocabulary for the typed-judgement seam. Kept apart from `types.ts`
 * so that module stays free of runtime values while consumers that only want
 * the vocabulary can still name the failure they are handling.
 * @module @zhchxiao123/dsh-jev/errors
 */

/**
 * Why one {@link JevRuntime.ask} call failed. Callers branch on this rather
 * than on message text: a missing credential reference and an unreachable
 * endpoint need different operator responses, and collapsing them into one
 * opaque failure hides which one happened.
 */
export type JevErrorCode =
  /** The request never reached a provider: the seam rejected its shape. */
  | 'JEV_INVALID_REQUEST'
  /** The configured credential reference resolves to nothing. */
  | 'JEV_CREDENTIAL_MISSING'
  /** The endpoint could not be reached at all (DNS, TCP, proxy, redirect refusal). */
  | 'JEV_UNAVAILABLE'
  /** The configured per-request deadline elapsed. */
  | 'JEV_TIMEOUT'
  /** The service refused the call for rate reasons and retries were exhausted. */
  | 'JEV_RATE_LIMITED'
  /** The service answered with a non-success status that is not a rate refusal. */
  | 'JEV_HTTP_ERROR'
  /** The service answered successfully with something that cannot be decoded. */
  | 'JEV_BAD_RESPONSE'
  /** The caller withdrew the request. Not a failure of the judgement itself. */
  | 'JEV_ABORTED'

/** Every {@link JevErrorCode}, for exhaustiveness checks and test enumeration. */
export const JEV_ERROR_CODES: readonly JevErrorCode[] = [
  'JEV_INVALID_REQUEST',
  'JEV_CREDENTIAL_MISSING',
  'JEV_UNAVAILABLE',
  'JEV_TIMEOUT',
  'JEV_RATE_LIMITED',
  'JEV_HTTP_ERROR',
  'JEV_BAD_RESPONSE',
  'JEV_ABORTED',
]

/**
 * The one failure type this seam raises. `ask()` throws rather than returning
 * an error value on purpose: whether an unavailable judgement should fail open
 * or fail closed is the consumer's policy, and a transport that swallows its
 * own failures takes that choice away from every consumer at once.
 */
export class JevError extends Error {
  /** Which failure this is; see {@link JevErrorCode}. */
  readonly code: JevErrorCode

  /**
   * @param message - what happened, in operator-facing terms.
   * @param code - the failure classification.
   * @param options - standard error options; `cause` carries the underlying throw.
   */
  constructor(message: string, code: JevErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JevError'
    this.code = code
  }
}
