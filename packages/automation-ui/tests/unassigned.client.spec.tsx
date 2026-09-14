// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AutomationRequest } from '@zhchxiao123/dsh-automation-web/client'
import { Unassigned } from '../src/client/unassigned.tsx'
import { plan, subscription, t } from './fixtures.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const reply = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }))
function pending() {
  let resolve!: (response: Response) => void; let reject!: (error: Error) => void
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
it.each(['plan', 'subscription'] as const)('shows legacy %s records only on request and explicitly claims before refreshing', async (kind) => {
  const requests: AutomationRequest[] = []; let claimed = false
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest; requests.push(body)
    if (body.method === 'claim') { claimed = true; return reply(kind === 'plan' ? plan() : subscription()) }
    return reply({ plans: claimed ? [] : [{ ...plan(), projectId: null }],
      subscriptions: claimed ? [] : [{ ...subscription(), projectId: null }] })
  })
  const changed = vi.fn(async () => {})
  render(<Unassigned sessionId="session" kind={kind} t={t} changed={changed} />)
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByText(t('unassigned'))); fireEvent.click(screen.getByRole('button', { name: t('refresh') }))
  await screen.findByText(kind === 'plan' ? 'Schedule plan' : 'owner/sub')
  fireEvent.click(screen.getByRole('button', { name: t('claim') }))
  await screen.findByText(t('empty'))
  expect(requests[1]).toEqual({ method: 'claim', sessionId: 'session', kind, id: kind === 'plan' ? 'plan' : 'sub' })
  expect(changed).toHaveBeenCalledOnce()
})
it('retains a failed claim for retry and coalesces concurrent requests', async () => {
  const request = pending(); let calls = 0
  vi.stubGlobal('fetch', async () => { calls += 1; return calls === 1 ? request.promise : reply({ plans: [], subscriptions: [] }) })
  render(<Unassigned sessionId="one" kind="plan" t={t} changed={vi.fn(async () => {})} />)
  fireEvent.click(screen.getByText(t('unassigned')))
  const refresh = screen.getByRole('button', { name: t('refresh') })
  fireEvent.click(refresh); fireEvent.click(refresh)
  expect(calls).toBe(1)
  await act(async () => { request.reject(new Error('project-mismatch')) })
  expect(screen.getByRole('alert').textContent).toContain('project-mismatch')
  fireEvent.click(refresh); await screen.findByText(t('empty')); expect(screen.queryByRole('alert')).toBeNull()
})
it.each(['read', 'claim'] as const)('ignores an obsolete %s resolution after changing project', async (kind) => {
  const request = pending(); let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls += 1
    if (kind === 'read' || calls > 1) return request.promise
    return reply({ plans: [plan()], subscriptions: [] })
  })
  const changed = vi.fn(async () => {})
  const view = render(<Unassigned sessionId="one" kind="plan" t={t} changed={changed} />)
  fireEvent.click(screen.getByText(t('unassigned'))); fireEvent.click(screen.getByRole('button', { name: t('refresh') }))
  if (kind === 'claim') { await screen.findByText('Schedule plan'); fireEvent.click(screen.getByRole('button', { name: t('claim') })) }
  view.unmount()
  await act(async () => { request.resolve(reply(kind === 'read' ? { plans: [], subscriptions: [] } : plan())) })
  expect(changed).not.toHaveBeenCalled(); expect(calls).toBe(kind === 'read' ? 1 : 2)
})
it('ignores a late failure after unmount', async () => {
  const request = pending(); vi.stubGlobal('fetch', () => request.promise)
  const view = render(<Unassigned sessionId="one" kind="plan" t={t} changed={vi.fn(async () => {})} />)
  fireEvent.click(screen.getByText(t('unassigned'))); fireEvent.click(screen.getByRole('button', { name: t('refresh') }))
  view.unmount(); await act(async () => { request.reject(new Error('late')) })
  expect(screen.queryByRole('alert')).toBeNull()
})
it('does not read legacy state after the project changes during the committed-state refresh', async () => {
  let done!: () => void
  const refresh = new Promise<void>((resolve) => { done = resolve })
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest
    return reply(body.method === 'claim' ? plan() : { plans: [plan()], subscriptions: [] })
  })
  const changed = vi.fn(() => refresh)
  const view = render(<Unassigned sessionId="one" kind="plan" t={t} changed={changed} />)
  fireEvent.click(screen.getByText(t('unassigned'))); fireEvent.click(screen.getByRole('button', { name: t('refresh') }))
  await screen.findByText('Schedule plan'); fireEvent.click(screen.getByRole('button', { name: t('claim') }))
  await waitFor(() => { expect(changed).toHaveBeenCalledOnce() }); view.unmount()
  await act(async () => { done() })
})
