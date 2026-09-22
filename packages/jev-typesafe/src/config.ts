/**
 * Deployment-varying choices for the TypeSafe provider. Every tunable lives
 * here; nothing in this package hardcodes an endpoint, a model, or a deadline.
 * @module @zhchxiao123/dsh-jev-typesafe/config
 */

import z from '@deepseek-ai/schemastery'

/** Endpoint root the System One API is served from. */
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
/**
 * A pinned version rather than the `jev-latest` alias. An alias moves when a
 * release ships, and a consumer's confidence thresholds are tuned against the
 * model that produced them — a silently newer model reads as drift in the
 * consumer's own data.
 */
export const DEFAULT_MODEL = 'jev-1.13.0'
/** Per-attempt deadline; the SDK applies it to each retry separately. */
export const DEFAULT_TIMEOUT_MS = 20_000
/** Retries after the first attempt, for rate refusals and server failures. */
export const DEFAULT_MAX_RETRIES = 2

/** Provider configuration. */
export interface Config {
  /**
   * Credential reference naming the API key — an environment-variable-shaped
   * identifier such as `TYPESAFE_API_KEY`, resolved through `ctx.credentials`
   * on every call. Required: there is no default, because defaulting it would
   * silently pick a credential on the deployment's behalf.
   */
  readonly apiKeyRef?: string
  /** Endpoint root. */
  readonly baseURL?: string
  /** Model that answers; pin a version when thresholds are tuned. */
  readonly model?: string
  /** Per-attempt deadline in milliseconds. */
  readonly timeoutMs?: number
  /** Retries after the first attempt. `0` disables retrying. */
  readonly maxRetries?: number
}

/** The config with every default applied. */
export type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  apiKeyRef: z.string(),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
  maxRetries: z.number().step(1).min(0).default(DEFAULT_MAX_RETRIES),
})

/**
 * Check what the schema cannot. Schemastery object properties are optional by
 * default and the schema admits `{}` and `null`, so the schema is a type filter
 * and this is the validation. The parameter is `unknown` for the same reason:
 * declaring it as {@link Config} would make each guard look unreachable.
 *
 * @param raw - the configuration as the composition supplied it.
 * @throws Error naming the offending config path.
 */
export function assertConfig(raw: unknown): asserts raw is ResolvedConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('jev-typesafe: config must be an object')
  }
  const config = raw as Record<string, unknown>
  const apiKeyRef = config.apiKeyRef
  if (typeof apiKeyRef !== 'string' || apiKeyRef.length === 0) {
    throw new Error('jev-typesafe: config.apiKeyRef must be a non-empty credential reference name')
  }
  assertBaseUrl(config.baseURL)
  const model = config.model
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('jev-typesafe: config.model must be a non-empty model identifier')
  }
  const timeoutMs = config.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('jev-typesafe: config.timeoutMs must be a positive whole number of milliseconds')
  }
  const maxRetries = config.maxRetries
  if (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error('jev-typesafe: config.maxRetries must be a whole number of retries, zero or more')
  }
}

/**
 * Refuse an endpoint that carries anything but an origin and a path. A base URL
 * with credentials in it would put a secret somewhere no credential seam can
 * rotate, and a query or fragment would be silently dropped when a path is
 * appended.
 *
 * @param value - the configured `baseURL`.
 * @throws Error naming what the URL carries.
 */
function assertBaseUrl(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('jev-typesafe: config.baseURL must be a non-empty URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new Error(`jev-typesafe: config.baseURL must be an absolute URL: ${value}`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`jev-typesafe: config.baseURL must be http or https, not ${url.protocol}`)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('jev-typesafe: config.baseURL must not carry credentials; use config.apiKeyRef')
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('jev-typesafe: config.baseURL must not carry a query or fragment')
  }
}
