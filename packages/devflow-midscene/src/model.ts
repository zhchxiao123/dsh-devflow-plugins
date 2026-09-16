/** Resolve public credential references per operation; never mutate process.env. */
import { redactSecret } from './secret-redaction.ts'
import { MODEL_FAMILY_VALUES } from '@midscene/shared/env'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type { AcceptanceProfile } from './config.ts'

export interface ModelEnvironment {
  environment: Record<string, string>
  redact(value: string): string
  capability: 'available' | 'unknown'
}

/** Resolve a selected model without assuming the chat adapter shares its protocol. */
export async function resolveModel(ctx: Context, profile: AcceptanceProfile, signal?: AbortSignal): Promise<ModelEnvironment> {
  signal?.throwIfAborted()
  if (!MODEL_FAMILY_VALUES.some(family => family === profile.family)) throw new Error('MODEL_INCOMPATIBLE: unsupported Midscene model family')
  const credentials = ctx.get('credentials')
  if (!credentials) throw new Error('MODEL_NOT_CONFIGURED: credential service is unavailable')
  let secret: string | undefined
  try {
    if (profile.credentialRef) secret = (await credentials.resolve(credentialRef(profile.credentialRef)))?.value
    else if (profile.credentialRecord) {
      const record = await credentials.readRecord(parseCredentialKey(profile.credentialRecord))
      if (record?.kind === 'api-key') secret = record.key
    }
  } catch {
    throw new Error('MODEL_UNAVAILABLE: credential provider failed')
  }
  if (!secret) throw new Error('MODEL_NOT_CONFIGURED: selected credential has no API key')
  let capability: 'available' | 'unknown' = 'unknown'
  const llm = ctx.get('llm')
  if (profile.provider && llm) {
    let model
    try { model = await llm.resolveModelInfo(profile.provider, profile.model, signal) }
    catch { throw new Error('MODEL_UNAVAILABLE: model capability lookup failed') }
    if (model.inputModalities) {
      if (!model.inputModalities.includes('image')) throw new Error('MODEL_INCOMPATIBLE: selected model rejects image input')
      capability = 'available'
    }
  }
  signal?.throwIfAborted()
  const key = secret
  return {
    environment: {
      MIDSCENE_MODEL_API_KEY: key, MIDSCENE_MODEL_NAME: profile.model,
      MIDSCENE_MODEL_BASE_URL: profile.baseUrl, MIDSCENE_MODEL_FAMILY: profile.family,
    },
    capability,
    // Short local credentials can also be substrings of JSON numbers or literals.
    // Redact their quoted values and authentication contexts without corrupting reports.
    redact: value => redactSecret(value, key)
      .replace(/([?&](?:token|key|api_key)=)[^&\s]+/gi, '$1[REDACTED]'),
  }
}
