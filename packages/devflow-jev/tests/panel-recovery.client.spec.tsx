// @vitest-environment jsdom
// Interrupted work is one click from continuing, a finished audit is read by
// its conclusion rather than by "the call ended", and an unavailable
// judgement names its failure class instead of quoting provider prose.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JevRunSnapshot } from '@zhchxiao123/dsh-jev'
import type { AuditSummary, EvaluationSummary } from '../src/types.ts'
import type { WebRequest } from '../src/web.ts'
import { JudgementPanel } from '../src/client/panel.tsx'
import { providerError } from '../src/client/presentation.ts'
import { zh, type Key } from '../src/client/locales.ts'

const t = (key: Key): string => zh[key]

const interruptedAudit: AuditSummary = {
  manifest: { id: 'audit-halted', root: '/project/.devflow', profile: 'release', createdAt: '2026-09-23T03:00:00Z', checks: [], cardCount: 2 },
  state: { runId: 'audit-halted', status: 'interrupted', total: 4, completed: 0, failed: 0, results: [], findings: [], createdAt: '2026-09-23T03:00:00Z' },
}
const concludedAudit: AuditSummary = {
  manifest: { id: 'audit-done', root: '/project/.devflow', profile: 'release', createdAt: '2026-09-23T02:00:00Z', checks: [], cardCount: 1 },
  state: { runId: 'audit-done', status: 'completed', total: 1, completed: 1, failed: 0, results: [], findings: [], conclusion: 'healthy', createdAt: '2026-09-23T02:00:00Z' },
}
const interruptedRun: JevRunSnapshot = {
  definition: { id: 'run-halted', scope: { kind: 'custom', id: 'x', title: 'Gate check' }, template: { id: 'custom-checklist', version: '1' }, createdAt: '2026-09-23T01:00:00Z', checks: [] },
  state: { runId: 'run-halted', status: 'interrupted', total: 2, completed: 0, failed: 0, results: [], createdAt: '2026-09-23T01:00:00Z' },
}
const unavailableEvaluation: EvaluationSummary = {
  id: 'eval-unavailable', subject: { kind: 'request', title: 'Verify the pelican', body: 'b', digest: 'd' }, assessmentKind: 'release-readiness',
  status: 'unavailable', decision: 'unavailable', confidence: 0, reasons: ['The judgement provider was unavailable; no Devflow action was taken.'],
  createdAt: '2026-09-23T00:00:00Z', error: { code: 'JEV_UNAVAILABLE', message: 'fetch failed' },
}

function mockApi() {
  const requests: WebRequest[] = []
  const reply = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string) as WebRequest
    requests.push(input)
    switch (input.method) {
      case 'context': return reply({ projectName: 'Example project', projectPath: '/project', genericRunsAvailable: true })
      case 'audit-list': return reply([interruptedAudit, concludedAudit])
      case 'run-list': return reply([interruptedRun])
      case 'list': return reply([unavailableEvaluation])
      case 'assistance-list': return reply([])
      default: return reply({ runId: input.method, jobId: 'job-1' })
    }
  }))
  return requests
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('resumes interrupted audits and runs straight from their cards, with the interruption explained', async () => {
  const requests = mockApi()
  render(<JudgementPanel sessionId="session-one" visible refreshMs={5000} t={t} />)
  expect((await screen.findAllByText(zh.interrupted)).length).toBe(2)
  expect(screen.getAllByText(zh.interruptedCardHint)).toHaveLength(2)
  const resumes = screen.getAllByRole('button', { name: zh.resumeAudit })
  expect(resumes).toHaveLength(2)
  fireEvent.click(resumes[0]!)
  await act(async () => {})
  expect(requests).toContainEqual({ method: 'audit-resume', sessionId: 'session-one', runId: 'audit-halted' })
  fireEvent.click(screen.getAllByRole('button', { name: zh.resumeAudit })[1]!)
  await act(async () => {})
  expect(requests).toContainEqual({ method: 'run-resume', sessionId: 'session-one', runId: 'run-halted' })
})

it('reads a finished audit by its conclusion and never by the bare end of execution', async () => {
  mockApi()
  render(<JudgementPanel sessionId="session-one" visible refreshMs={5000} t={t} />)
  expect(await screen.findByText(zh.healthy)).toBeTruthy()
  expect(screen.queryByText(zh.completed)).toBeNull()
})

it('names the failure class of an unavailable judgement instead of quoting provider prose', async () => {
  mockApi()
  render(<JudgementPanel sessionId="session-one" visible refreshMs={5000} t={t} />)
  expect(await screen.findByText(zh.errUnreachable)).toBeTruthy()
  expect(screen.queryByText(/judgement provider was unavailable/)).toBeNull()
})

describe('providerError', () => {
  it.each([
    ['JEV_INVALID_REQUEST', zh.errInvalidRequest],
    ['JEV_CREDENTIAL_MISSING', zh.errCredentialMissing],
    ['JEV_UNAVAILABLE', zh.errUnreachable],
    ['JEV_TIMEOUT', zh.errTimeout],
    ['JEV_RATE_LIMITED', zh.errRateLimited],
    ['JEV_HTTP_ERROR', zh.errHttp],
    ['JEV_BAD_RESPONSE', zh.errBadResponse],
    ['JEV_ABORTED', zh.cancelled],
    ['SOMETHING_NEW', 'SOMETHING_NEW'],
    [undefined, zh.unavailable],
  ])('classifies %s', (code, text) => {
    expect(providerError(code, t)).toBe(text)
  })
})
