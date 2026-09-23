// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { JevRunSnapshot } from '@zhchxiao123/dsh-jev'
import type { AuditSummary, EvaluationRecord } from '../src/types.ts'
import type { WebRequest } from '../src/web.ts'
import { JudgementPanel } from '../src/client/panel.tsx'
import { zh, type Key } from '../src/client/locales.ts'
const t = (key: Key): string => zh[key]
const at = '2026-09-22T00:00:00Z'
const check = {
  id: 'check-one',
  cardId: '0002',
  cardTitle: 'Ship safely',
  stage: 'testing' as const,
  stageRevision: 4,
  assessmentKind: 'release-readiness' as const,
  evidenceDigest: 'digest',
  rubricVersion: '2',
}
const summary: AuditSummary = {
  manifest: {
    id: 'audit-one',
    root: '/project/.devflow',
    profile: 'release',
    createdAt: at,
    checks: [check, { ...check, id: 'pending-check', cardTitle: 'Pending task' }],
    cardCount: 2,
  },
  state: {
    runId: 'audit-one',
    status: 'completed-with-errors',
    total: 2,
    completed: 1,
    failed: 1,
    results: [{ check, status: 'failed', error: 'provider offline', completedAt: at }],
    findings: [
      {
        severity: 'blocking',
        code: 'test-evidence-missing',
        cardId: '0002',
        message: 'No registered test-report supports release readiness.',
      },
    ],
    conclusion: 'blocked',
    createdAt: at,
  },
}
const generic: JevRunSnapshot = {
  definition: {
    id: 'generic-one',
    scope: { kind: 'repository', id: 'repo', title: 'Review repository contracts' },
    template: { id: 'contract-review', version: '1' },
    createdAt: at,
    checks: [
      {
        id: 'contract',
        subject: { kind: 'file', id: 'api.ts', title: 'API compatibility' },
        evidenceDigest: 'digest',
        request: {
          state: 'Interface evidence supplied by the caller',
          questions: {
            compatible: { type: 'noul', instructions: 'Is this API compatible?' },
            missing: { type: 'noul', instructions: 'Was a migration supplied?' },
          },
        },
      },
    ],
  },
  state: {
    runId: 'generic-one',
    status: 'completed',
    total: 1,
    completed: 1,
    failed: 0,
    results: [
      {
        checkId: 'contract',
        subject: { kind: 'file', id: 'api.ts', title: 'API compatibility' },
        evidenceDigest: 'digest',
        status: 'completed',
        response: { answers: { compatible: { type: 'noul', noul: 0.9 } } },
        completedAt: at,
      },
    ],
    createdAt: at,
  },
}
const evaluation: EvaluationRecord = {
  id: 'eval-one',
  root: '/project/.devflow',
  subject: {
    kind: 'request',
    title: 'Improve authentication',
    body: 'Add expiry handling and tests',
    digest: 'digest',
  },
  assessmentKind: 'planning',
  rubricVersion: '2',
  status: 'review',
  decision: 'propose',
  confidence: 0.82,
  answers: { codeSolvable: { type: 'noul', noul: 0.95 } },
  reasons: ['Expiry handling is actionable'],
  missingInformation: ['Confirm session duration'],
  recommendedServiceClass: 'standard',
  proposedTitle: 'Implement session expiry',
  proposedBody: 'Test expiration and renewal',
  createdAt: at,
}
const reply = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }), { status: 200 })
function mockApi(override?: (input: WebRequest, options: RequestInit) => Response | Promise<Response> | undefined) {
  const requests: WebRequest[] = []
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string) as WebRequest
    requests.push(input)
    const custom = override?.(input, options)
    if (custom !== undefined) return custom
    switch (input.method) {
      case 'context':
        return reply({ projectName: 'Example project', projectPath: '/project', genericRunsAvailable: true })
      case 'audit-list':
        return reply([summary])
      case 'run-list':
        return reply([generic])
      case 'list':
        return reply([evaluation])
      case 'read':
      case 'assess':
        return reply(evaluation)
      case 'audit-start':
        return reply(summary)
      default:
        return reply({ runId: 'audit-one', jobId: 'job-1' })
    }
  })
  vi.stubGlobal('fetch', fetch)
  return { requests, fetch }
}
function panel(sessionId = 'session-one', visible = true) {
  return <JudgementPanel sessionId={sessionId} visible={visible} refreshMs={5000} t={t} />
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('shows project context and filters generic, audit and assessment records', async () => {
  mockApi()
  render(panel())
  await screen.findByText('Example project')
  await screen.findByText('Review repository contracts')
  expect(screen.getAllByText(`${zh.details} →`)).toHaveLength(3)
  fireEvent.click(screen.getByRole('button', { name: /^通用审查 1$/ }))
  expect(screen.queryByText('Improve authentication')).toBeNull()
  expect(screen.getByText('Review repository contracts')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not-found' } })
  expect(screen.getByText(zh.noMatches)).toBeTruthy()
})
it('shows failed and unexecuted checks and resumes using the scoped run identity', async () => {
  const { requests } = mockApi()
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Devflow 审查.*发布准备/ }))
  expect(screen.getAllByText(/No registered test-report/)[0]).toBeTruthy()
  expect(screen.getByText('provider offline')).toBeTruthy()
  expect(screen.getByText('Pending task')).toBeTruthy()
  expect(screen.getByText(zh.pending)).toBeTruthy()
  expect(screen.getByText(zh.executionHint)).toBeTruthy()
  expect(screen.getByText(zh.auditScope)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.resumeAudit }))
  await act(async () => {})
  expect(requests).toContainEqual({ method: 'audit-resume', sessionId: 'session-one', runId: 'audit-one' })
})
it('renders generic questions, missing answers and supplied evidence without claiming a pass', async () => {
  mockApi()
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Review repository contracts/ }))
  fireEvent.click(screen.getByText('API compatibility'))
  expect(screen.getByText('Is this API compatible?')).toBeTruthy()
  expect(screen.getByText(`${zh.yesProbability} · 90%`)).toBeTruthy()
  expect(screen.getByText(zh.answerMissing)).toBeTruthy()
  expect(screen.getByText('Interface evidence supplied by the caller')).toBeTruthy()
  expect(screen.queryByText(zh.healthy)).toBeNull()
})
it('starts an audit with human-readable focus and explicit scope', async () => {
  const { requests } = mockApi()
  render(panel())
  await screen.findByText('Example project')
  fireEvent.click(screen.getByRole('button', { name: zh.newReview }))
  fireEvent.change(screen.getByLabelText(zh.profile), { target: { value: 'risk' } })
  expect(screen.getByText(zh.riskHint)).toBeTruthy()
  expect(screen.getByText(zh.auditScope)).toBeTruthy()
  fireEvent.change(screen.getByLabelText(zh.maxCards), { target: { value: '12' } })
  fireEvent.click(screen.getByRole('button', { name: zh.startAudit }))
  await act(async () => {})
  expect(requests).toContainEqual({ method: 'audit-start', sessionId: 'session-one', profile: 'risk', maxCards: 12 })
})
it('assesses a request and shows the proposed task before accepting it', async () => {
  let currentEvaluation = evaluation
  const { requests } = mockApi((input) => {
    if (input.method === 'accept') {
      currentEvaluation = { ...evaluation, status: 'created', createdCardId: '0042' }
      return reply(currentEvaluation)
    }
    if (input.method === 'list') return reply([currentEvaluation])
    if (input.method === 'read') return reply(currentEvaluation)
    return undefined
  })
  render(panel())
  await screen.findByText('Example project')
  fireEvent.click(screen.getByRole('button', { name: zh.newReview }))
  fireEvent.click(screen.getByRole('button', { name: zh.newAssessment }))
  fireEvent.change(screen.getByLabelText(zh.titleField), { target: { value: '  New requirement  ' } })
  fireEvent.change(screen.getByLabelText(zh.body), { target: { value: 'Need expiry tests' } })
  fireEvent.click(screen.getByRole('button', { name: zh.assess }))
  await screen.findByText('Implement session expiry')
  expect(screen.getByText(zh.codeSolvable)).toBeTruthy()
  expect(screen.getByText('Confirm session duration')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.accept }))
  await screen.findByText(`${zh.createdCard} · 0042`)
  expect(requests).toContainEqual({
    method: 'assess',
    sessionId: 'session-one',
    title: 'New requirement',
    body: 'Need expiry tests',
  })
  expect(requests).toContainEqual({ method: 'accept', sessionId: 'session-one', id: 'eval-one' })
})
it('retains previous data on refresh errors and explains a missing generic service', async () => {
  let failing = false
  mockApi(input =>
    input.method === 'context'
      ? reply({ projectName: 'Example project', projectPath: '/project', genericRunsAvailable: false })
      : input.method === 'audit-list' && failing
        ? Promise.reject(new Error('offline'))
        : undefined,
  )
  render(panel())
  await screen.findByText(zh.genericUnavailable)
  await screen.findByRole('button', { name: /Devflow 审查.*发布准备/ })
  failing = true
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByText(zh.stale)
  expect(screen.getByRole('button', { name: /Devflow 审查.*发布准备/ })).toBeTruthy()
})
it('explains owner failures without losing the selected review', async () => {
  mockApi(input =>
    input.method === 'audit-resume'
      ? new Response(JSON.stringify({ ok: false, error: 'LIVE_SESSION_REQUIRED' }))
      : undefined,
  )
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Devflow 审查.*发布准备/ }))
  fireEvent.click(screen.getByRole('button', { name: zh.resumeAudit }))
  expect(await screen.findByText(zh.liveRequired)).toBeTruthy()
  expect(screen.getByText('Pending task')).toBeTruthy()
})
it('does not call an empty review healthy', async () => {
  mockApi(input =>
    input.method === 'audit-list'
      ? reply([
        {
          ...summary,
          manifest: { ...summary.manifest, checks: [], cardCount: 0 },
          state: {
            ...summary.state,
            status: 'completed',
            total: 0,
            completed: 0,
            failed: 0,
            findings: [],
            results: [],
            conclusion: 'healthy',
          },
        },
      ])
      : undefined,
  )
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Devflow 审查.*发布准备/ }))
  expect(screen.getAllByText(zh.noChecks)).toHaveLength(2)
  expect(screen.queryByText(zh.healthy)).toBeNull()
})
it('loads in StrictMode and stops polling when the sidebar is hidden', async () => {
  vi.useFakeTimers()
  const { fetch } = mockApi()
  const view = render(<StrictMode>{panel()}</StrictMode>)
  await act(async () => {})
  expect(screen.getByText('Review repository contracts')).toBeTruthy()
  view.rerender(<StrictMode>{panel('session-one', false)}</StrictMode>)
  const count = fetch.mock.calls.length
  await act(async () => {
    vi.advanceTimersByTime(20000)
  })
  expect(fetch.mock.calls.length).toBe(count)
})
it('aborts obsolete reads and resets project state when switching sessions', async () => {
  let staleResolve: ((value: Response) => void) | undefined
  let staleSignal: AbortSignal | null | undefined
  mockApi((input, options) => {
    if (input.sessionId === 'old' && input.method === 'context') {
      staleSignal = options.signal
      return new Promise<Response>((resolve) => {
        staleResolve = resolve
      })
    }
    if (input.sessionId === 'new' && input.method === 'context')
      return reply({ projectName: 'New project', projectPath: '/new', genericRunsAvailable: false })
    return undefined
  })
  const view = render(panel('old'))
  view.rerender(panel('new'))
  await screen.findByText('New project')
  expect(staleSignal?.aborted).toBe(true)
  await act(async () => {
    staleResolve?.(reply({ projectName: 'Old project', projectPath: '/old', genericRunsAvailable: true }))
  })
  expect(screen.queryByText('Old project')).toBeNull()
  expect(screen.getByText('New project')).toBeTruthy()
})
it('handles missing context without any network calls', () => {
  const { fetch } = mockApi()
  render(panel(''))
  expect(screen.getByText(zh.noProject)).toBeTruthy()
  expect(fetch).not.toHaveBeenCalled()
})
it('opens audit evaluation details and returns to the audit', async () => {
  mockApi(input =>
    input.method === 'audit-list'
      ? reply([
        {
          ...summary,
          state: {
            ...summary.state,
            results: [{ check, status: 'completed', evaluationId: evaluation.id, completedAt: at }],
          },
        },
      ])
      : undefined,
  )
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Devflow 审查.*发布准备/ }))
  const checkSection = screen.getByText('Ship safely').closest('div')?.parentElement
  if (checkSection === null || checkSection === undefined) throw new Error('check missing')
  fireEvent.click(within(checkSection).getByRole('button', { name: zh.details }))
  await screen.findByText('Implement session expiry')
  fireEvent.click(screen.getByRole('button', { name: /返回记录/ }))
  expect(screen.getByText('Pending task')).toBeTruthy()
})
it('refreshes an open assessment after another session rejects it', async () => {
  let currentEvaluation = evaluation
  mockApi((input) => {
    if (input.method === 'list') return reply([currentEvaluation])
    if (input.method === 'read') return reply(currentEvaluation)
    return undefined
  })
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Improve authentication/ }))
  await screen.findByRole('button', { name: zh.accept })
  currentEvaluation = { ...evaluation, status: 'rejected' }
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByText(zh.rejected)
  expect(screen.queryByRole('button', { name: zh.accept })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /返回记录/ }))
  expect(screen.getByRole('button', { name: /已拒绝.*Improve authentication/ })).toBeTruthy()
  expect(screen.queryByText(zh.propose)).toBeNull()
})
it('cancels a generic run without sending an audit control', async () => {
  const { requests } = mockApi(input =>
    input.method === 'run-list'
      ? reply([{ ...generic, state: { ...generic.state, status: 'running' } }])
      : input.method === 'run-cancel'
        ? reply({ runId: generic.definition.id, outcome: 'requested' })
        : undefined,
  )
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Review repository contracts/ }))
  fireEvent.click(screen.getByRole('button', { name: zh.cancelAudit }))
  await screen.findByText(zh.cancelledNotice)
  expect(requests).toContainEqual({ method: 'run-cancel', runId: generic.definition.id, sessionId: 'session-one' })
  expect(requests.some(input => input.method === 'audit-cancel')).toBe(false)
})
it('shows loading failures without claiming an empty project', async () => {
  mockApi(() => Promise.reject(new Error('offline')))
  render(panel())
  await screen.findByRole('alert')
  expect(screen.queryByText(zh.empty)).toBeNull()
})
it('starts a generic checklist from plain evidence and opens the durable result', async () => {
  const { requests } = mockApi(input => input.method === 'run-start' ? reply(generic) : undefined)
  render(panel())
  await screen.findByText('Example project')
  fireEvent.click(screen.getByRole('button', { name: zh.newReview }))
  fireEvent.click(screen.getByRole('button', { name: zh.runs }))
  expect(screen.getByText(zh.genericFormScope)).toBeTruthy()
  const start = screen.getByRole('button', { name: zh.startGeneric }) as HTMLButtonElement
  expect(start.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText(zh.reviewTitle), { target: { value: '  API review  ' } })
  fireEvent.change(screen.getByLabelText(zh.evidence), { target: { value: 'Diff and test output' } })
  fireEvent.change(screen.getByLabelText(zh.checklistQuestions), { target: { value: ' Is the API compatible?\n\n Are failures tested? ' } })
  fireEvent.click(start)
  await screen.findByText('API compatibility')
  expect(requests).toContainEqual({ method: 'run-start', sessionId: 'session-one', title: 'API review', evidence: 'Diff and test output', questions: ['Is the API compatible?', 'Are failures tested?'] })
})
it('assesses an existing task without sending new-request fields', async () => {
  const { requests } = mockApi(input => input.method === 'assess-card' ? reply(evaluation) : undefined)
  render(panel())
  await screen.findByText('Example project')
  fireEvent.click(screen.getByRole('button', { name: zh.newReview }))
  fireEvent.click(screen.getByRole('button', { name: zh.assessExisting }))
  expect(screen.getByText(zh.cardAssessmentHint)).toBeTruthy()
  fireEvent.change(screen.getByLabelText(zh.cardId), { target: { value: ' 0042 ' } })
  fireEvent.change(screen.getByLabelText(zh.assessmentKind), { target: { value: 'test-impact' } })
  fireEvent.click(screen.getByRole('button', { name: zh.assess }))
  await screen.findByText('Implement session expiry')
  expect(requests).toContainEqual({ method: 'assess-card', sessionId: 'session-one', id: '0042', assessmentKind: 'test-impact' })
})
it('keeps the generic form input after a start error and disables unavailable generic service', async () => {
  let available = true
  mockApi(input => input.method === 'context'
    ? reply({ projectName: 'Example project', projectPath: '/project', genericRunsAvailable: available })
    : input.method === 'run-start' ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'LIVE_SESSION_REQUIRED' }))) : undefined)
  render(panel())
  await screen.findByText('Example project')
  fireEvent.click(screen.getByRole('button', { name: zh.newReview }))
  fireEvent.click(screen.getByRole('button', { name: zh.runs }))
  fireEvent.change(screen.getByLabelText(zh.reviewTitle), { target: { value: 'Review' } })
  fireEvent.change(screen.getByLabelText(zh.evidence), { target: { value: 'Evidence' } })
  fireEvent.change(screen.getByLabelText(zh.checklistQuestions), { target: { value: 'Is it compatible?' } })
  fireEvent.click(screen.getByRole('button', { name: zh.startGeneric }))
  await screen.findByText(zh.liveRequired)
  expect(screen.getByLabelText<HTMLTextAreaElement>(zh.evidence).value).toBe('Evidence')
  available = false
  cleanup()
  render(panel())
  await screen.findByText(zh.genericUnavailable)
  fireEvent.click(screen.getByRole('button', { name: zh.newReview }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.runs }).disabled).toBe(true)
})

it.each(['audit-cancel', 'run-resume'] as const)('routes %s only to its selected source', async (method) => {
  const { requests } = mockApi(input => input.method === 'audit-list'
    ? reply([{ ...summary, state: { ...summary.state, status: 'running', conclusion: undefined } }])
    : input.method === 'run-list' ? reply([{ ...generic, state: { ...generic.state, status: 'interrupted' } }]) : undefined)
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: method === 'audit-cancel' ? /Devflow 审查.*发布准备/ : /Review repository contracts/ }))
  if (method === 'audit-cancel') expect(screen.getByText(zh.incomplete)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: method === 'audit-cancel' ? zh.cancelAudit : zh.resumeAudit }))
  await act(async () => {})
  expect(requests.some(input => input.method === method)).toBe(true)
})
it('retains an open audit or run when it disappears from a refreshed listing', async () => {
  let removed = false
  mockApi(input => removed && ['audit-list', 'run-list'].includes(input.method) ? reply([]) : undefined)
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Devflow 审查.*发布准备/ }))
  removed = true
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await act(async () => {})
  expect(screen.getByText('Pending task')).toBeTruthy()
  cleanup(); removed = false; render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Review repository contracts/ }))
  removed = true
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await act(async () => {})
  expect(screen.getByText('API compatibility')).toBeTruthy()
})
it('shows empty reasons in assessment summaries without fabricating an explanation', async () => {
  mockApi(input => input.method === 'list' ? reply([{ ...evaluation, reasons: [] }]) : undefined)
  render(panel())
  expect(await screen.findByText(zh.noReasons)).toBeTruthy()
})
it('surfaces a detail refresh failure and cancels refresh on document hide', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let reads = 0
  let fail: (error: Error) => void = () => {}
  let signal: AbortSignal | null | undefined
  let slow = false
  mockApi((input, options) => {
    if (input.method !== 'read') return undefined
    if (++reads === 1) return reply(evaluation)
    if (!slow) return Promise.reject(new Error('detail refresh offline'))
    signal = options.signal
    return new Promise<Response>((_resolve, reject) => { fail = reject })
  })
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Improve authentication/ }))
  await screen.findAllByText(/detail refresh offline/)
  slow = true
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await act(async () => {})
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(signal?.aborted).toBe(false)
  act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
  expect(signal?.aborted).toBe(true)
  await act(async () => { fail(new Error('hidden detail should not display')) })
  expect(screen.queryByText('hidden detail should not display')).toBeNull()
})
it('ignores a late successful detail refresh after navigating back', async () => {
  let reads = 0
  let finish: (response: Response) => void = () => {}
  mockApi(input => input.method !== 'read' ? undefined : ++reads === 1 ? reply(evaluation)
    : new Promise<Response>((resolve) => { finish = resolve }))
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Improve authentication/ }))
  await screen.findByText('Implement session expiry')
  fireEvent.click(screen.getByRole('button', { name: /返回记录/ }))
  await act(async () => { finish(reply({ ...evaluation, subject: { ...evaluation.subject, title: 'Obsolete detail' } })) })
  expect(screen.queryByText('Obsolete detail')).toBeNull()
})
it.each(['read', 'audit-resume', 'accept', 'audit-start', 'assess', 'run-start', 'assess-card'] as const)(
  'discards %s results after the owning session unmounts', async (method) => {
    let finish: (response: Response) => void = () => {}
    let pending: AbortSignal | null | undefined
    mockApi((input, options) => {
      if (input.method !== method) return undefined
      pending = options.signal
      return new Promise<Response>((resolve) => { finish = resolve })
    })
    const view = render(panel())
    await screen.findByText('Example project')
    if (method === 'read' || method === 'accept') {
      fireEvent.click(screen.getByRole('button', { name: /Improve authentication/ }))
      if (method === 'accept') fireEvent.click(await screen.findByRole('button', { name: zh.accept }))
    } else if (method === 'audit-resume') {
      fireEvent.click(screen.getByRole('button', { name: /Devflow 审查.*发布准备/ }))
      fireEvent.click(screen.getByRole('button', { name: zh.resumeAudit }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: zh.newReview }))
      if (method === 'assess') {
        fireEvent.click(screen.getByRole('button', { name: zh.newAssessment }))
        fireEvent.change(screen.getByLabelText(zh.titleField), { target: { value: 'Requirement' } })
        fireEvent.change(screen.getByLabelText(zh.body), { target: { value: 'Acceptance' } })
      } else if (method === 'run-start') {
        fireEvent.click(screen.getByRole('button', { name: zh.runs }))
        fireEvent.change(screen.getByLabelText(zh.reviewTitle), { target: { value: 'Review' } })
        fireEvent.change(screen.getByLabelText(zh.evidence), { target: { value: 'Evidence' } })
        fireEvent.change(screen.getByLabelText(zh.checklistQuestions), { target: { value: 'Does it persist?' } })
      } else if (method === 'assess-card') {
        fireEvent.click(screen.getByRole('button', { name: zh.assessExisting }))
        fireEvent.change(screen.getByLabelText(zh.cardId), { target: { value: '0042' } })
      }
      fireEvent.click(screen.getByRole('button', { name: method === 'audit-start' ? zh.startAudit : method === 'run-start' ? zh.startGeneric : zh.assess }))
    }
    await act(async () => {})
    expect(pending?.aborted).toBe(false)
    view.unmount()
    expect(pending?.aborted).toBe(true)
    await act(async () => { finish(reply(method === 'audit-start' ? summary : method === 'run-start' ? generic : evaluation)) })
    expect(screen.queryByRole('article')).toBeNull()
  },
)
it('does not surface action errors after unmounting', async () => {
  let fail: (error: Error) => void = () => {}
  mockApi(input => input.method === 'read' ? new Promise<Response>((_resolve, reject) => { fail = reject }) : undefined)
  const view = render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Improve authentication/ }))
  view.unmount()
  await act(async () => { fail(new Error('aborted action')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('does not replace a selected assessment with an unrelated response identity', async () => {
  let reads = 0
  mockApi(input => input.method === 'read' ? reply(++reads === 1 ? evaluation : { ...evaluation, id: 'different-record', proposedTitle: 'Unrelated proposal' }) : undefined)
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Improve authentication/ }))
  await screen.findByText('Implement session expiry')
  await act(async () => {})
  expect(screen.queryByText('Unrelated proposal')).toBeNull()
})

it('coalesces rapid action clicks before React commits the busy state', async () => {
  let finish: (response: Response) => void = () => {}
  const { requests } = mockApi(input => input.method === 'audit-resume' ? new Promise<Response>((resolve) => { finish = resolve }) : undefined)
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Devflow 审查.*发布准备/ }))
  const resume = screen.getByRole<HTMLButtonElement>('button', { name: zh.resumeAudit })
  act(() => { resume.click(); resume.click() })
  expect(requests.filter(input => input.method === 'audit-resume')).toHaveLength(1)
  await act(async () => { finish(reply({ runId: summary.manifest.id, outcome: 'requested' })) })
  expect(screen.getByText(zh.cancelledNotice)).toBeTruthy()
})
