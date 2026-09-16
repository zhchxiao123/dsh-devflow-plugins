import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { resolveModel } from '../src/model.ts'
import { Config, validateProfiles } from '../src/config.ts'
import type { AcceptanceProfile } from '../src/config.ts'

class Credentials extends CredentialProvider {
  value: ResolvedCredential | undefined = { value: 'top-secret', source: 'test' }
  record: CredentialRecord | undefined
  resolve(): Promise<ResolvedCredential | undefined> { return Promise.resolve(this.value) }
  readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(this.record) }
  describe(): never { throw new Error('unused') }
  set(): never { throw new Error('unused') }
  unset(): never { throw new Error('unused') }
  describeRecord(): never { throw new Error('unused') }
  listRecords(): never { throw new Error('unused') }
  modifyRecord(): never { throw new Error('unused') }
  deleteRecord(): never { throw new Error('unused') }
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const profile = (): AcceptanceProfile => ({ workspace: '/workspace', output: '/output', model: 'vision', family: 'glm-v',
  baseUrl: 'https://model.test/v1', targetUrl: 'http://localhost:3000', browserMode: 'puppeteer', credentialRef: 'TEST_KEY',
  timeoutMs: 1000, cleanupTimeoutMs: 100, maxSteps: 10 })

it.each(['42', 'true'])('short credential %s preserves JSON numbers and booleans', async (key) => {
  const { ctx, credentials } = await boot()
  credentials.value = { value: key, source: 'test' }
  const model = await resolveModel(ctx, profile())
  expect(JSON.parse(model.redact(JSON.stringify({ cost: 1842, ok: true, key })))).toEqual({ cost: 1842, ok: true, key: '[REDACTED]' })
  expect(model.redact(key)).toBe('[REDACTED]')
  expect(model.redact(`Bearer ${key}; bearer ${key}`)).toBe('Bearer [REDACTED]; bearer [REDACTED]')
})
async function boot(): Promise<{ ctx: Context; credentials: Credentials }> {
  const ctx = new Context(); contexts.push(ctx)
  let credentials!: Credentials
  await ctx.plugin((child: Context) => { credentials = new Credentials(child) }).await()
  return { ctx, credentials }
}

it('model references are resolved afresh without mutating the parent environment', async () => {
  const { ctx, credentials } = await boot()
  const before = process.env.MIDSCENE_MODEL_API_KEY
  const first = await resolveModel(ctx, profile())
  expect(first.capability).toBe('unknown')
  expect(first.environment.MIDSCENE_MODEL_API_KEY).toBe('top-secret')
  expect(first.redact('top-secret https://x?token=abc&key=def')).toBe('[REDACTED] https://x?token=[REDACTED]&key=[REDACTED]')
  credentials.value = { value: 'rotated', source: 'test' }
  expect((await resolveModel(ctx, profile())).environment.MIDSCENE_MODEL_API_KEY).toBe('rotated')
  expect(process.env.MIDSCENE_MODEL_API_KEY).toBe(before)
})

it('record credentials require an API key; ambient grant records do not become Midscene secrets', async () => {
  const { ctx, credentials } = await boot()
  const p = profile(); delete p.credentialRef; p.credentialRecord = 'llm-pi-ai/provider'
  await expect(resolveModel(ctx, p)).rejects.toThrow('no API key')
  credentials.record = { kind: 'api-key', key: 'record-key' }
  expect((await resolveModel(ctx, p)).environment.MIDSCENE_MODEL_API_KEY).toBe('record-key')
  delete p.credentialRecord
  await expect(resolveModel(ctx, p)).rejects.toThrow('no API key')
  credentials.value = undefined
  await expect(resolveModel(ctx, profile())).rejects.toThrow('no API key')
})

it('rejects absent services, unsupported families and cancelled requests without model calls', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await expect(resolveModel(ctx, profile())).rejects.toThrow('credential service')
  await expect(resolveModel(ctx, { ...profile(), family: 'gpt-4o' })).rejects.toThrow('unsupported Midscene model family')
  await expect(resolveModel(ctx, profile(), AbortSignal.abort())).rejects.toThrow()
})

it('does not expose provider exception strings', async () => {
  const { ctx, credentials } = await boot()
  vi.spyOn(credentials, 'resolve').mockRejectedValueOnce(new Error('top-secret'))
  await expect(resolveModel(ctx, profile())).rejects.toThrow('MODEL_UNAVAILABLE: credential provider failed')
  await ctx.plugin(LlmRuntime).await()
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockRejectedValueOnce(new Error('top-secret'))
  await expect(resolveModel(ctx, { ...profile(), provider: 'test' })).rejects.toThrow('MODEL_UNAVAILABLE: model capability lookup failed')
})

it('checks published model modalities, keeps unknown explicit, and observes cancellation after lookup', async () => {
  const { ctx } = await boot()
  await ctx.plugin(LlmRuntime).await()
  const p = { ...profile(), provider: 'test' }
  const lookup = vi.spyOn(ctx.llm, 'resolveModelInfo')
  lookup.mockResolvedValueOnce({ provider: 'test', id: 'vision', name: 'Vision', inputModalities: ['image'] })
  expect((await resolveModel(ctx, p)).capability).toBe('available')
  lookup.mockResolvedValueOnce({ provider: 'test', id: 'vision', name: 'Vision', inputModalities: ['text'] })
  await expect(resolveModel(ctx, p)).rejects.toThrow('rejects image input')
  lookup.mockResolvedValueOnce({ provider: 'test', id: 'vision', name: 'Vision' })
  expect((await resolveModel(ctx, p)).capability).toBe('unknown')
  const abort = new AbortController()
  lookup.mockImplementationOnce(async () => { abort.abort(); return { provider: 'test', id: 'vision', name: 'Vision' } })
  await expect(resolveModel(ctx, p, abort.signal)).rejects.toThrow()
})

it('validates profiles and resolves schema defaults', () => {
  expect(Config({})).toEqual({ profiles: {} })
  validateProfiles({ profiles: {} })
  validateProfiles({ profiles: { local: profile() } })
  validateProfiles({ profiles: { local: { ...profile(), reportBaseUrl: 'http://localhost:3082' } } })
  validateProfiles({ profiles: { local: { ...profile(), browserMode: 'cdp', cdpEndpoint: 'ws://localhost:9222' } } })
  const p = profile(); delete p.credentialRef; p.credentialRecord = 'llm-pi-ai/provider'
  validateProfiles({ profiles: { local: p } })
  const parsed = Config({ profiles: { local: { workspace: '/a', output: '/b', model: 'v', family: 'glm-v',
    baseUrl: 'https://model.test', targetUrl: 'http://localhost', credentialRef: 'KEY' } } })
  expect(parsed.profiles.local?.timeoutMs).toBe(180000)
})

it.each([
  { workspace: 'relative' }, { output: '/workspace' }, { baseUrl: 'file:///model' }, { baseUrl: 'https://a:b@model.test' },
  { reportBaseUrl: 'https://harness.test?token=x' }, { targetUrl: 'https://model.test?key=x' }, { targetUrl: 'https://model.test#x' }, { credentialRef: '' },
  { credentialRecord: 'x/y' }, { credentialRef: 'bad-key' }, { credentialRef: undefined, credentialRecord: 'INVALID' },
  { browserMode: 'cdp', cdpEndpoint: '' }, { browserMode: 'cdp', cdpEndpoint: 'http://local' },
  { browserMode: 'cdp', cdpEndpoint: 'ws://a:b@local' }, { browserMode: 'cdp', cdpEndpoint: 'ws://local?key=x' },
  { browserMode: 'cdp', cdpEndpoint: 'ws://local#x' }, { cdpEndpoint: 'ws://local' },
  { suiteSha256: 'bad' }, { model: '' }, { model: 'a\nb' },
])('rejects invalid deployment configuration %j', (change) => {
  expect(() => { validateProfiles({ profiles: { local: Object.assign(profile(), change) } }) }).toThrow()
})
it('rejects invalid profile names', () => {
  expect(() => { validateProfiles({ profiles: { 'Bad Name': profile() } }) }).toThrow('lowercase identifiers')
})
