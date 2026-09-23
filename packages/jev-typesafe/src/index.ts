/**
 * Service Provider for `ctx.jev`, backed by TypeSafe's Jev over the System One
 * API. Mounting this row is what registers the seam — the definition package
 * ships only the base class and the vocabulary.
 *
 * The SDK owns transport: retries with backoff, `retry-after` on a rate
 * refusal, per-attempt deadlines, and one error class per failure. It carries
 * no dependencies of its own and issues every request through the global
 * `fetch`, so a deployment's outbound proxy policy applies here exactly as it
 * does to the rest of the harness.
 * @module @zhchxiao123/dsh-jev-typesafe
 */

import { Context } from '@deepseek-ai/cordis'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { Fetch } from '@typesafe-ai/sdk'
import JevRuntime, { JevError } from '@zhchxiao123/dsh-jev'
import type { Answer, JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Config, assertConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { classify, decodeAnswer, decodeUsage, encodeQuestions, encodeState } from './wire.ts'

export { Config, assertConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { classify, decodeAnswer, decodeUsage, encodeQuestions, encodeState } from './wire.ts'

/** Cordis plugin name, as the Loader reports it. */
export const name = 'jev-typesafe'
/**
 * The credential seam is required rather than optional: without it this
 * provider can never resolve a key, so deferring activation until it exists is
 * more honest than answering every call with the same failure.
 */
export const inject = ['credentials']

/** Answers typed judgements with TypeSafe's Jev. */
export class TypeSafeJev extends JevRuntime {
  static inject = inject
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly credentials: CredentialProvider

  /**
   * @param ctx - the context this service is registered on.
   * @param config - the reviewed provider configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    assertConfig(config)
    // The reference is a shell-identifier grammar the credential seam owns, and
    // the value arrives from a composition file. Rejecting it here rather than
    // at the first call makes a typo a boot failure instead of a judgement that
    // is quietly never available.
    if (!isCredentialRefName(config.apiKeyRef)) {
      throw new Error(`jev-typesafe: config.apiKeyRef "${config.apiKeyRef}" is not a valid credential reference name`)
    }
    this.config = config
    // Cordis deliberately rebinds a Service method's `this.ctx` to the caller
    // context. A generic `ctx.jev` consumer should not have to inject this
    // provider's private credential dependency, so retain the provider-owned
    // service reference established by this plugin's own `credentials`
    // injection. The provider still resolves through it on every call, keeping
    // key rotation live.
    this.credentials = ctx.credentials
  }

  /**
   * Build the client for one call.
   *
   * Constructed per call rather than held, because the API key is resolved per
   * call and the SDK takes it at construction; a retained client would pin the
   * credential that happened to be current when this plugin loaded. The client
   * carries no connection state, so this costs an object.
   *
   * Overridable so a spec can supply its own `fetch` without turning a test
   * seam into a configuration field.
   *
   * @param apiKey - the resolved key.
   * @returns the client for this call.
   */
  protected createClient(apiKey: string): TypeSafeClient {
    return new TypeSafeClient({
      apiKey,
      baseURL: this.config.baseURL,
      defaultModel: this.config.model,
      retry: { maxRetries: this.config.maxRetries },
    })
  }

  protected override async perform(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    const apiKey = await this.resolveKey()
    let result
    try {
      const client = this.createClient(apiKey)
      result = await client.systemOne(
        { state: encodeState(request.state), questions: encodeQuestions(request.questions), model: this.config.model },
        { timeout: this.config.timeoutMs, ...signal === undefined ? {} : { signal } },
      )
    } catch (error: unknown) {
      throw classify(error)
    }
    return this.decode(request, result)
  }

  /**
   * Resolve the configured credential reference for this one call.
   *
   * @returns the key.
   * @throws JevError with `JEV_CREDENTIAL_MISSING` when nothing is configured.
   */
  private async resolveKey(): Promise<string> {
    const ref = this.config.apiKeyRef
    let record
    try {
      record = await this.credentials.resolve(credentialRef(ref))
    } catch (error: unknown) {
      throw new JevError(`jev-typesafe: credential "${ref}" could not be resolved`, 'JEV_CREDENTIAL_MISSING', { cause: error })
    }
    const value = record?.value
    if (typeof value !== 'string' || value.length === 0) {
      throw new JevError(`jev-typesafe: credential "${ref}" is not configured`, 'JEV_CREDENTIAL_MISSING')
    }
    return value
  }

  /**
   * Read one successful response.
   *
   * @param request - the request these answers belong to.
   * @param result - the response as the API returned it.
   * @returns the decoded response.
   * @throws JevError with `JEV_BAD_RESPONSE` when the envelope itself is unreadable.
   */
  private decode(request: JevRequest, result: unknown): JevResponse {
    if (result === null || typeof result !== 'object') {
      throw new JevError('jev-typesafe: the API returned no response body', 'JEV_BAD_RESPONSE')
    }
    const envelope = result as Record<string, unknown>
    const raw = envelope.answers
    if (raw === null || typeof raw !== 'object') {
      throw new JevError('jev-typesafe: the API response carried no answers', 'JEV_BAD_RESPONSE')
    }
    const source = raw as Record<string, unknown>
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      // An answer that will not decode leaves its key out. The seam preserves
      // that absence, so a caller sees "not judged" rather than a value this
      // package chose on the model's behalf.
      const answer = decodeAnswer(question, source[id])
      if (answer !== undefined) answers[id] = answer
    }
    const usage = decodeUsage(envelope.usage)
    const model = envelope.model
    return {
      answers,
      ...usage === undefined ? {} : { usage },
      ...typeof model === 'string' && model.length > 0 ? { model } : {},
    }
  }
}

export default TypeSafeJev

export type { Fetch }
