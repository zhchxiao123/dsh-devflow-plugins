import { afterEach, expect, it, vi } from 'vitest'
import { request } from '../src/client/api.ts'
afterEach(() => { vi.unstubAllGlobals() })
it('rejects an HTTP failure before consuming a purported success body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 403 })))
  await expect(request({ method: 'run-list', sessionId: 'owner' })).rejects.toThrow('devflow-jev-http-403')
})
it.each([null, 'not an envelope'])('rejects invalid response envelope %j', async (value) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value))))
  await expect(request({ method: 'list', sessionId: 'owner' })).rejects.toThrow('invalid-response')
})
it('preserves a server lifecycle error instead of returning data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'JEV_RUNS_UNAVAILABLE' }))))
  await expect(request({ method: 'run-list', sessionId: 'owner' })).rejects.toThrow('JEV_RUNS_UNAVAILABLE')
})
it('passes the caller abort signal and scoped identity to HTTP', async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ ok: true, data: { runId: 'review', outcome: 'requested' } })))
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  await expect(request({ method: 'run-cancel', sessionId: 'owner', runId: 'review' }, controller.signal)).resolves.toEqual({ runId: 'review', outcome: 'requested' })
  const options = fetch.mock.calls[0]?.[1]
  expect(options?.signal).toBe(controller.signal)
  if (typeof options?.body !== 'string') throw new Error('Expected JSON request body')
  expect(JSON.parse(options.body)).toEqual({ method: 'run-cancel', sessionId: 'owner', runId: 'review' })
})
