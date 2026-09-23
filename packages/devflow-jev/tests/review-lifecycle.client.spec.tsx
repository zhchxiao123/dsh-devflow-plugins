// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRecords } from '../src/client/use-records.ts'
import { JudgementPanel } from '../src/client/panel.tsx'
import type { WebRequest } from '../src/web.ts'
import { zh, type Key } from '../src/client/locales.ts'
const t = (key: Key): string => zh[key]
const reply = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

it('aborts an in-flight list when the document hides and ignores its late response after return', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let slow = false
  let pendingSignal: AbortSignal | null | undefined
  let resolvePending: ((value: Response) => void) | undefined
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string) as WebRequest
    if (input.method === 'context') return reply({ projectName: slow ? 'New context' : 'Initial context', projectPath: '/project', genericRunsAvailable: false })
    if (input.method === 'audit-list' && slow && resolvePending === undefined) {
      pendingSignal = options.signal
      return new Promise<Response>((resolve) => { resolvePending = resolve })
    }
    return reply([])
  })
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useRecords('session', true, 5000))
  await act(async () => {})
  expect(result.current.data.context?.projectName).toBe('Initial context')
  slow = true
  let refresh: Promise<void> | undefined
  await act(async () => { refresh = result.current.refresh() })
  expect(result.current.loading).toBe(true)
  act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
  expect(pendingSignal?.aborted).toBe(true)
  expect(result.current.loading).toBe(false)
  await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
  expect(result.current.data.context?.projectName).toBe('New context')
  await act(async () => { resolvePending?.(reply([{ obsolete: true }])); await refresh })
  expect(result.current.data.audits).toEqual([])
  expect(result.current.errors).toEqual([])
})

it('recovers from a malformed record through the visible retry action', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const preventExpectedError = (event: ErrorEvent) => { event.preventDefault() }
  window.addEventListener('error', preventExpectedError)
  let malformed = true
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string) as WebRequest
    if (input.method === 'context') return reply({ projectName: 'Recovery project', projectPath: '/project', genericRunsAvailable: false })
    if (input.method === 'audit-list') return reply(malformed ? [{ missingManifest: true }] : [])
    return reply([])
  }))
  render(<JudgementPanel sessionId="session" visible refreshMs={5000} t={t} />)
  expect((await screen.findByRole('alert')).textContent).toContain(zh.fatal)
  window.removeEventListener('error', preventExpectedError)
  malformed = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  expect(await screen.findByText('Recovery project')).toBeTruthy()
  expect(await screen.findByText(zh.empty)).toBeTruthy()
  expect(screen.queryByText(zh.fatal)).toBeNull()
})

it('ignores an aborted request rejection and does not poll over an active request', async () => {
  vi.useFakeTimers()
  let reject: (reason: Error) => void = () => {}
  const fetch = vi.fn(() => new Promise<Response>((_resolve, fail) => { reject = fail }))
  vi.stubGlobal('fetch', fetch)
  const view = renderHook(() => useRecords('session', true, 100))
  await act(async () => { vi.advanceTimersByTime(300) })
  expect(fetch).toHaveBeenCalledTimes(3)
  view.unmount()
  await act(async () => { reject(new Error('aborted')) })
})
