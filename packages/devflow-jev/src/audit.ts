/* oxlint-disable @stylistic/max-len */
import { createHash, randomUUID } from 'node:crypto'
import type { DevCard, DevflowStore } from '@zhchxiao123/dsh-devflow'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import { collectEvidence, evidenceDigest } from './evidence.ts'
import { RUBRIC_VERSION } from './rubric.ts'
import type { AssessmentKind, AuditCheck, AuditFinding, AuditManifest, AuditProfile, AuditState, CardEvidence, EvaluationRecord } from './types.ts'

const BY_STAGE: Readonly<Record<DevCard['stage'], readonly AssessmentKind[]>> = {
  draft: ['intake', 'planning', 'spec-delta'], designing: ['planning', 'implementation-risk'], developing: ['implementation-risk', 'test-impact'], reviewing: ['review-scope', 'test-impact', 'spec-delta'], ready: ['test-impact', 'release-readiness'], testing: ['test-impact', 'release-readiness'], blocked: ['planning', 'implementation-risk'], done: [],
}
const BY_PROFILE: Readonly<Record<AuditProfile, readonly AssessmentKind[]>> = {
  'delivery-health': ['planning', 'implementation-risk', 'test-impact', 'release-readiness', 'spec-delta', 'intake', 'review-scope'],
  release: ['test-impact', 'release-readiness'], risk: ['planning', 'implementation-risk', 'test-impact'], spec: ['planning', 'review-scope', 'spec-delta'], full: ['intake', 'planning', 'implementation-risk', 'test-impact', 'review-scope', 'release-readiness', 'spec-delta'],
}
function id(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 20) }
function stratified(cards: readonly DevCard[], maxCards: number): DevCard[] {
  const queues = Object.keys(BY_STAGE).map(stage => cards.filter(card => card.stage === stage)); const selected: DevCard[] = []
  while (selected.length < maxCards && queues.some(queue => queue.length > 0)) for (const queue of queues) { const card = queue.shift(); if (card !== undefined) selected.push(card); if (selected.length === maxCards) break }
  return selected
}
export interface PlannedAudit { readonly manifest: AuditManifest; readonly evidence: ReadonlyMap<string, CardEvidence> }
export async function planAudit(store: DevflowStore, root: string, profile: AuditProfile, maxCards: number): Promise<PlannedAudit> {
  const board = await store.list(undefined, root); const candidates = board.filter(card => card.stage !== 'done' && BY_STAGE[card.stage].some(kind => BY_PROFILE[profile].includes(kind))); const selected = stratified(candidates, maxCards); const evidence = new Map<string, CardEvidence>(); const checks: AuditCheck[] = []
  for (const card of selected) {
    const item = await collectEvidence(root, card, board, await store.history(DevflowCardId(card.id), root)); evidence.set(card.id, item); const digest = evidenceDigest(item)
    for (const kind of BY_STAGE[card.stage].filter(candidate => BY_PROFILE[profile].includes(candidate))) checks.push({ id: id(`${card.id}\0${card.stageRevision}\0${kind}\0${digest}\0${RUBRIC_VERSION}`), cardId: card.id, cardTitle: card.title, stage: card.stage, stageRevision: card.stageRevision, assessmentKind: kind, evidenceDigest: digest, rubricVersion: RUBRIC_VERSION })
  }
  const createdAt = new Date().toISOString(); return { manifest: { id: randomUUID(), root, profile, createdAt, checks, cardCount: selected.length }, evidence }
}
export function initialState(manifest: AuditManifest): AuditState { return { runId: manifest.id, status: 'planned', total: manifest.checks.length, completed: 0, failed: 0, results: [], findings: [], createdAt: manifest.createdAt } }
export function aggregate(manifest: AuditManifest, state: AuditState, evaluations: readonly EvaluationRecord[]): { findings: AuditFinding[]; conclusion: NonNullable<AuditState['conclusion']>; report: string } {
  const findings: AuditFinding[] = []
  for (const result of state.results) if (result.status === 'stale') findings.push({ severity: 'warning', code: 'check-stale', cardId: result.check.cardId, message: `${result.check.assessmentKind}: ${result.error ?? 'evidence changed after the audit snapshot'}` })
  for (const evaluation of evaluations) {
    const card = evaluation.subject.kind === 'card' ? { cardId: evaluation.subject.cardId } : {}
    if (evaluation.status === 'unavailable') findings.push({ severity: 'warning', code: 'judgement-unavailable', ...card, message: `${evaluation.assessmentKind} judgement was unavailable.` })
    for (const gap of evaluation.evidence?.gaps ?? []) findings.push({ severity: evaluation.assessmentKind === 'release-readiness' ? 'blocking' : 'warning', code: `evidence-${gap.kind}`, ...card, message: `${gap.path}: ${gap.detail}` })
    if (evaluation.assessmentKind === 'release-readiness') {
      if (!evaluation.evidence?.artifacts.some(item => item.kind === 'test-report')) findings.push({ severity: 'blocking', code: 'test-evidence-missing', ...card, message: 'No registered test-report supports release readiness.' })
      const answer = evaluation.answers.releaseDecision
      if (answer?.type === 'choice' && (answer.choice === 'blocked' || answer.choice === 'unavailable')) findings.push({ severity: 'blocking', code: 'release-not-ready', ...card, message: `Release judgement: ${answer.choice}.` })
    }
    const risk = evaluation.answers.changeRisk; if (risk?.type === 'score' && risk.score >= 3) findings.push({ severity: risk.score >= 3.5 ? 'blocking' : 'warning', code: 'implementation-risk', ...card, message: `Implementation risk score is ${risk.score.toFixed(2)}.` })
    const acceptance = evaluation.answers.acceptanceExecutable; if (acceptance?.type === 'noul' && acceptance.noul < 0.6) findings.push({ severity: 'warning', code: 'acceptance-not-executable', ...card, message: 'Acceptance conditions are not executable from current evidence.' })
    const fresh = evaluation.answers.testEvidenceFresh; if (fresh?.type === 'noul' && fresh.noul < 0.6) findings.push({ severity: 'warning', code: 'test-evidence-stale', ...card, message: 'Test evidence is missing or not tied to the current card revision.' })
    const changed = evaluation.answers.behaviorChanged; const covered = evaluation.answers.specificationCovered
    if (changed?.type === 'noul' && changed.noul >= 0.6 && covered?.type === 'noul' && covered.noul < 0.6) findings.push({ severity: 'warning', code: 'spec-delta', ...card, message: 'Behavior changed without sufficient specification coverage.' })
    if (evaluation.evidence !== undefined && ['ready', 'testing', 'done'].includes(evaluation.evidence.card.stage)) for (const child of evaluation.evidence.relations.children) if (child.stage !== 'done') findings.push({ severity: 'blocking', code: 'active-child', ...card, message: `Child ${child.id} remains ${child.stage}.` })
  }
  const covered = new Set(state.results.filter(result => result.status === 'completed').map(result => result.check.id))
  if (covered.size < manifest.checks.length) findings.push({ severity: 'warning', code: 'coverage-incomplete', message: `${manifest.checks.length - covered.size} planned checks did not complete.` })
  const unique = [...new Map(findings.map(finding => [`${finding.code}\0${finding.cardId ?? ''}\0${finding.message}`, finding])).values()]
  const conclusion = evaluations.length > 0 && evaluations.every(evaluation => evaluation.status === 'unavailable') && covered.size === 0 ? 'unavailable' : unique.some(finding => finding.severity === 'blocking') ? 'blocked' : covered.size < manifest.checks.length ? 'incomplete' : unique.length > 0 ? 'attention-required' : 'healthy'
  const lines = [`# JEV project audit ${manifest.id}`, '', `- Profile: ${manifest.profile}`, `- Cards: ${manifest.cardCount}`, `- Checks: ${state.completed}/${state.total}`, `- Conclusion: ${conclusion}`, '', '## Findings', '']
  lines.push(...(unique.length === 0 ? ['No findings.'] : unique.map(finding => `- [${finding.severity}] ${finding.cardId === undefined ? '' : `${finding.cardId}: `}${finding.message}`)))
  return { findings: unique, conclusion, report: lines.join('\n') + '\n' }
}
