// Configuration is checked at load, not at first call. A judgement capability
// that fails only when something first needs judging is a capability nobody
// notices is broken until it matters.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TypeSafeJev, assertConfig } from '@zhchxiao123/dsh-jev-typesafe'
import { MemoryCredentials } from './doubles.ts'

const VALID = {
  apiKeyRef: 'TYPESAFE_API_KEY',
  baseURL: 'https://api.typesafe.ai',
  model: 'jev-1.13.0',
  timeoutMs: 20_000,
  maxRetries: 2,
}

describe('assertConfig', () => {
  it('accepts a fully defaulted configuration', () => {
    expect(() => { assertConfig(VALID) }).not.toThrow()
  })

  it.each([
    ['a non-object', null, 'config must be an object'],
    ['a missing reference', { ...VALID, apiKeyRef: undefined }, 'config.apiKeyRef'],
    ['an empty reference', { ...VALID, apiKeyRef: '' }, 'config.apiKeyRef'],
    ['an empty model', { ...VALID, model: '' }, 'config.model'],
    ['a zero timeout', { ...VALID, timeoutMs: 0 }, 'config.timeoutMs'],
    ['a fractional timeout', { ...VALID, timeoutMs: 1.5 }, 'config.timeoutMs'],
    ['negative retries', { ...VALID, maxRetries: -1 }, 'config.maxRetries'],
    ['a missing base URL', { ...VALID, baseURL: '' }, 'config.baseURL'],
    ['a relative base URL', { ...VALID, baseURL: '/v1' }, 'config.baseURL'],
    ['a non-http scheme', { ...VALID, baseURL: 'ftp://api.typesafe.ai' }, 'http or https'],
    ['credentials in the URL', { ...VALID, baseURL: 'https://u:p@api.typesafe.ai' }, 'must not carry credentials'],
    ['a query string', { ...VALID, baseURL: 'https://api.typesafe.ai?v=1' }, 'query or fragment'],
    ['a fragment', { ...VALID, baseURL: 'https://api.typesafe.ai#x' }, 'query or fragment'],
  ])('rejects %s', (_label, config, message) => {
    expect(() => { assertConfig(config) }).toThrow(message)
  })
})

describe('TypeSafeJev construction', () => {
  it('refuses a reference outside the credential grammar at load', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await expect(ctx.plugin(TypeSafeJev, { ...VALID, apiKeyRef: 'not a ref' }))
      .rejects.toThrow('is not a valid credential reference name')
  })
})
