// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { JevRequest, JevRunSnapshot } from '@zhchxiao123/dsh-jev'
import type { EvaluationRecord } from '../src/types.ts'
import { EvaluationDetail, GenericDetail } from '../src/client/review-detail.tsx'
import { Answers, ErrorNotice, NextStep } from '../src/client/review-parts.tsx'
import { date, reasonText } from '../src/client/presentation.ts'
import { zh, type Key } from '../src/client/locales.ts'
const t = (key: Key): string => zh[key]
const at = '2026-09-22T00:00:00Z'
const evaluation: EvaluationRecord = {
  id: 'proposal', root: '/project/.devflow', subject: { kind: 'request', title: 'Evaluate expiry handling', body: 'Require session expiry tests', digest: 'request' },
  assessmentKind: 'intake', rubricVersion: '2', status: 'review', decision: 'propose', confidence: 0.8,
  answers: {}, reasons: [], missingInformation: [], recommendedServiceClass: 'standard', createdAt: at,
}
afterEach(cleanup)

it.each(['standard', 'risk', 'blocked'])('preserves custom generic choice %s without Devflow interpretation', (choice) => {
  const request: JevRequest = { state: { domain: 'Network routing' }, questions: { mode: { type: 'choice', instructions: 'Which routing mode applies?', criteria: { standard: null, risk: null, blocked: null } } } }
  render(<Answers request={request} answers={{ mode: { type: 'choice', choice, confidence: 0.8, probabilities: { standard: 0.8, risk: 0.1, blocked: 0.1 } } }} t={t} />)
  expect(screen.getByText(`${zh.selected} · ${choice}`)).toBeTruthy()
  expect(screen.getByText(`${zh.confidence} 80%`)).toBeTruthy()
  expect(screen.queryByText(`${zh.selected} · ${zh.standard}`)).toBeNull()
  expect(screen.getByText('Which routing mode applies?')).toBeTruthy()
})

it('shows score scale from a generic rubric and preserves structured instructions', () => {
  const request: JevRequest = { state: null, questions: {
    fit: { type: 'score', instructions: { question: 'How complete?', area: 'delivery' }, criteria: ['none', 'partial', 'complete'] },
    pending: { type: 'noul', instructions: 'Was there a release?' },
  } }
  render(<Answers request={request} answers={{ fit: { type: 'score', score: 1.256, confidence: 0.6, probabilities: [0.1, 0.544, 0.356] } }} t={t} />)
  expect(screen.getByText('fit')).toBeTruthy()
  expect(screen.getByText(`${zh.score} · 1.26 / 2`)).toBeTruthy()
  expect(screen.getByText(zh.answerMissing)).toBeTruthy()
  const question = screen.getAllByText(zh.question)[0]
  if (question === undefined) throw new Error('question disclosure missing')
  fireEvent.click(question)
  expect(screen.getByText(/How complete/).tagName).toBe('PRE')
})

it('uses answer distributions for Devflow scores and readable known choices', () => {
  render(<Answers answers={{ risk: { type: 'score', score: 2, probabilities: [0, 0, 1, 0, 0], confidence: 1 }, serviceClass: { type: 'choice', choice: 'standard', probabilities: { standard: 1 }, confidence: 1 } }} t={t} />)
  expect(screen.getByText(zh.workRisk)).toBeTruthy()
  expect(screen.getByText(`${zh.score} · 2 / 4`)).toBeTruthy()
  expect(screen.getByText(`${zh.selected} · ${zh.standard}`)).toBeTruthy()
})

it('distinguishes failed generic checks from pending checks and exposes structured evidence', () => {
  const subject = { kind: 'file', id: 'README.md', title: 'Review README' }
  const value: JevRunSnapshot = {
    definition: { id: 'generic', scope: { kind: 'repository', id: 'project', title: 'Repository review' }, template: { id: 'custom', version: '1' }, createdAt: at, checks: [
      { id: 'readme', subject, evidenceDigest: 'one', request: { state: { path: 'README.md', excerpt: 'API contract' }, questions: { fit: { type: 'noul', instructions: 'Does the contract match?' } } } },
      { id: 'pending', subject: { ...subject, title: 'Review API' }, evidenceDigest: 'two', request: { state: null, questions: { fit: { type: 'noul', instructions: 'Does the API match?' } } } },
    ] },
    state: { runId: 'generic', status: 'completed-with-errors', total: 2, completed: 1, failed: 1, results: [{ checkId: 'readme', subject, evidenceDigest: 'one', status: 'failed', error: { code: 'JEV_UNAVAILABLE', message: 'Provider offline' }, completedAt: at }], createdAt: at },
  }
  const control = vi.fn()
  render(<GenericDetail value={value} busy={false} t={t} control={control} />)
  fireEvent.click(screen.getByText('Review README'))
  expect(screen.getByText('JEV_UNAVAILABLE: Provider offline')).toBeTruthy()
  expect(screen.getByText(zh.pending)).toBeTruthy()
  expect(screen.getAllByText(zh.answerMissing)).toHaveLength(2)
  expect(screen.getAllByText(/"excerpt": "API contract"/)[0]?.textContent).toContain('README.md')
  fireEvent.click(screen.getByRole('button', { name: zh.resumeAudit }))
  expect(control).toHaveBeenCalledWith('resume')
})

it('shows unavailable card evaluations without offering proposal actions or inventing evidence', () => {
  const value: EvaluationRecord = { ...evaluation, subject: { kind: 'card', cardId: '0042', title: 'Card review', stage: 'developing', stageRevision: 3, digest: 'card' }, status: 'unavailable', decision: 'unavailable', error: { code: 'JEV_CREDENTIAL_MISSING', message: 'Credential required' } }
  render(<EvaluationDetail value={value} busy={false} t={t} decide={vi.fn()} />)
  expect(screen.getByText(zh.unavailableHint)).toBeTruthy()
  expect(screen.getByText(zh.noReasons)).toBeTruthy()
  expect(screen.getByText(zh.noEvidence)).toBeTruthy()
  fireEvent.click(screen.getByText(zh.errorDetail))
  expect(screen.getByText('JEV_CREDENTIAL_MISSING: Credential required')).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.accept })).toBeNull()
})

it('shows card evidence gaps and artifact excerpts independently of model answers', () => {
  const value: EvaluationRecord = { ...evaluation, decision: 'manual-review', evidence: {
    card: { id: '0042', title: 'Implement expiry', body: 'Registered card evidence', stage: 'testing', stageRevision: 5, serviceClass: 'standard' }, journal: [],
    gaps: [{ kind: 'missing', path: 'test-report.md', detail: 'No test report registered' }],
    artifacts: [{ path: 'design.md', kind: 'design', digest: 'design', excerpt: 'Expiry design excerpt', truncated: false }], relations: { children: [] },
  } }
  render(<EvaluationDetail value={value} busy={false} t={t} decide={vi.fn()} />)
  expect(screen.getByText('Registered card evidence')).toBeTruthy()
  expect(screen.getByText('test-report.md: No test report registered')).toBeTruthy()
  fireEvent.click(screen.getByText('design.md'))
  expect(screen.getByText('Expiry design excerpt')).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.accept })).toBeNull()
})

it('allows rejecting a displayed request proposal and disables decisions while busy', () => {
  const decide = vi.fn()
  const view = render(<EvaluationDetail value={evaluation} busy={false} t={t} decide={decide} />)
  expect(screen.getByRole('heading', { level: 4 }).textContent).toBe(evaluation.subject.title)
  expect(screen.getAllByText('Require session expiry tests')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: zh.reject }))
  expect(decide).toHaveBeenCalledWith('reject')
  view.rerender(<EvaluationDetail value={evaluation} busy t={t} decide={decide} />)
  fireEvent.click(screen.getByRole('button', { name: zh.accept }))
  expect(decide).toHaveBeenCalledTimes(1)
})

it('cancels a running review and explains denied ownership', () => {
  const control = vi.fn()
  render(<><NextStep status="running" busy={false} control={control} t={t} /><ErrorNotice errors={['Job owner does not match this session']} t={t} /></>)
  expect(screen.getByText(zh.runningHint)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.cancelAudit }))
  expect(control).toHaveBeenCalledWith('cancel')
  expect(screen.getByText(zh.denied)).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('Job owner does not match')
})

it('translates rubric numbers while retaining free prose and unreadable timestamps', () => {
  expect(reasonText('value 3', t)).toBe(`${zh.workValue} · 3 / 4`)
  expect(reasonText('risk 2.5', t)).toBe(`${zh.workRisk} · 2.5 / 4`)
  expect(reasonText('code-solvable 0.9', t)).toBe(`${zh.codeSolvable} · 90%`)
  expect(reasonText('information unavailable', t)).toBe(`${zh.informationSufficient} · ${zh.unavailable}`)
  expect(reasonText('Investigate network settings', t)).toBe('Investigate network settings')
  expect(date('unknown timestamp')).toBe('unknown timestamp')
})
