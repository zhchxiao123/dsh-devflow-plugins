import { afterEach, expect, it, vi } from 'vitest'
import { automationRequest } from '../src/client.ts'
import { publicError } from '../src/errors.ts'
afterEach(() => vi.unstubAllGlobals())
it('rejects HTTP failures, malformed envelopes and malformed successful wire data', async () => {
  for (const [status, body] of [[503, {}], [200, {}], [200, { ok: true, data: { schedulerAvailable: true } }], [200, { ok: false, error: 'blocked' }]] as const) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))
    await expect(automationRequest({ sessionId: 'fixture-session', method: 'overview' })).rejects.toThrow()
  }
})
it('publishes fixed domain errors and hides arbitrary exceptions', () => {
  expect(publicError(new Error('Storage capacity reached'))).toBe('Storage capacity reached')
  expect(publicError(new Error('/private/token-secret'))).not.toContain('secret')
  expect(publicError('token-secret')).not.toContain('secret')
})
