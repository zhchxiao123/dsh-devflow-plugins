// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AssistanceMode, AssistanceRecord } from '../src/assistance-types.ts'
import type { WebRequest } from '../src/web.ts'
import { AssistanceDetail } from '../src/client/assistance-detail.tsx'
import { JudgementPanel } from '../src/client/panel.tsx'
import { en, zh, type Key } from '../src/client/locales.ts'
const t = (key: Key): string => zh[key]
const record: AssistanceRecord = {
  id: 'assist-one', workspace: '/project', sessionId: 'owner', turn: 2,
  card: { id: '0001-persist', revision: 4, stage: 'testing', title: 'Persist restored state' },
  event: 'completion', mode: 'observe', evidenceDigest: 'digest', policyVersion: '1',
  action: 'add-verification', reason: 'Restart behavior has no test evidence.',
  evidenceRefs: ['git:HEAD:abc123', 'src/store.ts'], gaps: ['Restart test missing'], confidence: 0.8,
  status: 'observed', outcome: 'unknown', elapsedMs: 123,
  createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture() {
  let available = true
  let mode: AssistanceMode | undefined = 'observe'
  let records: AssistanceRecord[] = [record]
  let readResponse: Promise<Response> | undefined
  const requests: WebRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    if (typeof options.body !== 'string') throw new Error('Expected JSON body')
    const input = JSON.parse(options.body) as WebRequest
    requests.push(input)
    if (input.method === 'assistance-read' && readResponse !== undefined) return readResponse
    const data = input.method === 'context'
      ? { projectName: 'Project', projectPath: '/project', genericRunsAvailable: false, assistanceAvailable: available, assistanceMode: mode }
      : input.method === 'assistance-list' ? records
        : input.method === 'assistance-read' ? records.find(value => value.id === input.id)
          : []
    return new Response(JSON.stringify({ ok: true, data }))
  }))
  return {
    requests,
    mode(value: AssistanceMode | undefined) { mode = value },
    waitRead(value: Promise<Response>) { readResponse = value },
    update(value: AssistanceRecord[]) { records = value },
    availability(value: boolean) { available = value },
  }
}
function panel(sessionId = 'owner') { return <JudgementPanel sessionId={sessionId} visible refreshMs={60_000} t={t} /> }
it('shows observed advice, task identity, gaps and effect unknown without implying resolution', async () => {
  const api = fixture(); render(panel())
  await screen.findByText(record.card?.title ?? '')
  fireEvent.click(screen.getByRole('button', { name: /^自动辅助 1$/ }))
  expect(screen.getByText(zh.observed)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Persist restored state/ }))
  const article = await screen.findByRole('article')
  expect(within(article).getByText(zh.outcomeUnknown)).toBeTruthy()
  expect(within(article).getByText(zh.assistanceHint)).toBeTruthy()
  expect(within(article).getByText('Restart test missing')).toBeTruthy()
  expect(within(article).getByText('src/store.ts')).toBeTruthy()
  expect(within(article).getByText(/0001-persist.*4.*testing/, { selector: 'p' })).toBeTruthy()
  expect(within(article).getByText(/owner.*2/, { selector: 'p' })).toBeTruthy()
  expect(within(article).getByText(/123 ms/)).toBeTruthy()
  expect(api.requests).toContainEqual({ method: 'assistance-read', sessionId: 'owner', id: record.id })
  expect(within(article).queryByRole('button', { name: zh.resumeAudit })).toBeNull()
})
it('refreshes delivered and unavailable records without changing unknown outcomes to success', async () => {
  const api = fixture(); render(panel())
  await screen.findByText(record.card?.title ?? '')
  const { card: _card, ...sessionRecord } = record
  api.update([{ ...record, status: 'delivered', mode: 'assist' }, { ...sessionRecord, id: 'offline', status: 'unavailable', reason: 'Provider timed out' }])
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByText(zh.delivered)
  expect(screen.getByText(zh.unavailable)).toBeTruthy()
  expect(screen.getAllByText(/效果未知/)).toHaveLength(2)
  expect(screen.getByText(/Provider timed out/)).toBeTruthy()
})
it('handles optional service absence and remount while retaining the other review views', async () => {
  const api = fixture(); api.availability(false); render(panel())
  await screen.findByText('Project')
  fireEvent.click(screen.getByRole('button', { name: /^自动辅助 0$/ }))
  expect(screen.getByText(zh.assistanceUnavailable)).toBeTruthy()
  expect(api.requests.some(input => input.method === 'assistance-list')).toBe(false)
  api.availability(true)
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByText(record.card?.title ?? '')
  expect(screen.queryByText(zh.assistanceUnavailable)).toBeNull()
  api.availability(false)
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByText(zh.assistanceUnavailable)
  expect(screen.queryByText(record.card?.title ?? '')).toBeNull()
})
it('does not retain the previous session records after switching projects', async () => {
  const api = fixture(); const view = render(panel())
  await screen.findByText(record.card?.title ?? '')
  api.update([])
  await act(async () => { view.rerender(panel('another-project')) })
  expect(screen.queryByText(record.card?.title ?? '')).toBeNull()
  expect(api.requests).toContainEqual({ method: 'assistance-list', sessionId: 'another-project' })
})
it('provides English labels for delivery and outcome as separate concepts', () => {
  expect(en.delivered).toBe('Delivered')
  expect(en.outcomeUnknown).toBe('Effect unknown')
  expect(en.assistanceHint).toContain('does not prove adoption or resolution')
})
it('keeps a fresh detail response when the list snapshot is older', async () => {
  const api = fixture(); render(panel())
  await screen.findByText(record.card?.title ?? '')
  api.update([{ ...record, status: 'delivered', updatedAt: '2026-09-23T00:01:00Z' }])
  fireEvent.click(screen.getByRole('button', { name: /Persist restored state/ }))
  const article = await screen.findByRole('article')
  expect(within(article).getByText(zh.delivered)).toBeTruthy()
  expect(within(article).getByText(zh.outcomeUnknown)).toBeTruthy()
})

it('shows session-scoped outcomes without inventing task identity or coverage', () => {
  const { card: _card, ...sessionRecord } = record
  render(<AssistanceDetail value={{ ...sessionRecord, gaps: [], evidenceRefs: [], status: 'delivered', outcome: 'check-passed', outcomeDetail: 'A later check passed; causality is unknown.' }} t={t} />)
  expect(screen.getAllByText(zh.sessionScope)).toHaveLength(2)
  expect(screen.getByText(zh.noGaps)).toBeTruthy()
  expect(screen.getByText(zh.noEvidence)).toBeTruthy()
  expect(screen.getByText(zh.checkPassed)).toBeTruthy()
  expect(screen.getByText('A later check passed; causality is unknown.')).toBeTruthy()
  expect(screen.getByText(zh.assistanceHint)).toBeTruthy()
})

it('discards a late detail response after switching to a different project', async () => {
  const api = fixture()
  let finish: (value: Response) => void = () => {}
  api.waitRead(new Promise((resolve) => { finish = resolve }))
  const view = render(panel())
  await screen.findByText(record.card?.title ?? '')
  fireEvent.click(screen.getByRole('button', { name: /Persist restored state/ }))
  api.update([])
  await act(async () => { view.rerender(panel('another-project')) })
  await act(async () => { finish(new Response(JSON.stringify({ ok: true, data: record }))) })
  expect(screen.queryByRole('article')).toBeNull()
  expect(screen.queryByText(record.card?.title ?? '')).toBeNull()
})

it('does not display a missing service mode as disabled', async () => {
  const api = fixture(); api.mode(undefined); render(panel())
  await screen.findByText(record.card?.title ?? '')
  fireEvent.click(screen.getByRole('button', { name: /^自动辅助 1$/ }))
  expect(screen.getByText(new RegExp(zh.assistanceMode + '.*' + zh.loadError))).toBeTruthy()
  expect(screen.queryByText(new RegExp(zh.assistanceMode + '.*' + zh.assistanceOff))).toBeNull()
})
