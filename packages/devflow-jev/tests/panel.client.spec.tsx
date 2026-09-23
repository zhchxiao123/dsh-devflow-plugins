// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WebRequest } from '../src/web.ts'
import { JudgementPanel } from '../src/client/panel.tsx'
import { zh, type Key } from '../src/client/locales.ts'

const t = (key: Key): string => zh[key]
const check = { id: '1234567890abcdef1234', cardId: '0002', cardTitle: 'Ship safely', stage: 'testing' as const, stageRevision: 4, assessmentKind: 'release-readiness' as const, evidenceDigest: 'digest', rubricVersion: '2' }
const summary = { manifest: { id: 'audit-one', root: '/project/.devflow', profile: 'release' as const, createdAt: '2026-09-22T00:00:00Z', checks: [check], cardCount: 2 }, state: { runId: 'audit-one', status: 'completed-with-errors' as const, total: 4, completed: 4, failed: 1, results: [{ check, status: 'failed' as const, error: 'provider offline', completedAt: '2026-09-22T00:01:00Z' }], findings: [{ severity: 'blocking' as const, code: 'test-evidence-missing', cardId: '0002', message: 'No registered test-report supports release readiness.' }], conclusion: 'blocked' as const, createdAt: '2026-09-22T00:00:00Z' } }
const reply = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }), { status: 200 })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('shows durable project audits, findings, and resume actions', async () => {
  const requests: WebRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => { const request = JSON.parse(options.body as string) as WebRequest; requests.push(request); if (request.method === 'audit-list') return reply([summary]); if (request.method === 'audit-resume') return reply({ runId: request.runId, jobId: 'jev-audit-2' }); return reply([]) }))
  render(<JudgementPanel sessionId="session-one" visible={true} refreshMs={5000} t={t} />)
  await screen.findByRole('button', { name: /release/ }); fireEvent.click(screen.getByRole('button', { name: /release/ }))
  expect(await screen.findByText(/No registered test-report/)).toBeTruthy()
  expect(screen.getByText(/provider offline/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.resumeAudit })); await act(async () => {})
  expect(requests).toContainEqual({ method: 'audit-resume', sessionId: 'session-one', runId: 'audit-one' })
})

it('starts a selected project audit profile', async () => {
  const requests: WebRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => { const request = JSON.parse(options.body as string) as WebRequest; requests.push(request); return request.method === 'audit-list' ? reply([]) : reply({ ...summary, jobId: 'jev-audit-1' }) }))
  render(<JudgementPanel sessionId="session-one" visible={true} refreshMs={5000} t={t} />); await screen.findByText(zh.noAudits)
  fireEvent.change(screen.getByLabelText(zh.profile), { target: { value: 'risk' } }); fireEvent.click(screen.getByRole('button', { name: zh.startAudit })); await act(async () => {})
  expect(requests).toContainEqual({ method: 'audit-start', sessionId: 'session-one', profile: 'risk', maxCards: 50 })
})
