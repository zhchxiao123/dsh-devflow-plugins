import type { AssistanceMode, AssistanceRecord } from '../assistance-types.ts'
import type { AuditProfile, AssessmentKind } from '../types.ts'
import type { Key, Translate } from './locales.ts'
const labels: Readonly<Record<string, Key>> = {
  observed: 'observed', delivering: 'delivering', delivered: 'delivered',
  'budget-exhausted': 'budgetExhausted', unknown: 'outcomeUnknown',
  'action-observed': 'actionObserved', 'check-passed': 'checkPassed', 'check-failed': 'checkFailed',
  'read-evidence': 'readEvidence', 'revise-plan': 'revisePlan', 'inspect-failure': 'inspectFailure',
  'add-verification': 'addVerification', 'review-change': 'reviewChange',
  'changed-code': 'changedCode', 'repeated-failure': 'repeatedFailure', completion: 'completion',
  off: 'assistanceOff', observe: 'assistanceObserve', assist: 'assistanceAssist',
  codeSolvable: 'codeSolvable',
  informationSufficient: 'informationSufficient',
  scopeClarity: 'scopeClarity',
  recommendedAction: 'recommendedAction',
  serviceClass: 'serviceClass',
  acceptanceExecutable: 'acceptanceExecutable',
  dependencyClarity: 'dependencyClarity',
  changeRisk: 'changeRisk',
  riskControlled: 'riskControlled',
  testCoverage: 'testCoverage',
  testEvidenceFresh: 'testEvidenceFresh',
  reviewBreadth: 'reviewBreadth',
  scopeAligned: 'scopeAligned',
  requiredEvidencePresent: 'requiredEvidencePresent',
  releaseDecision: 'releaseDecision',
  behaviorChanged: 'behaviorChanged',
  specificationCovered: 'specificationCovered',
  investigate: 'investigate',
  ask: 'ask',
  standard: 'standard',
  express: 'express',
  emergency: 'emergency',
  ready: 'ready',
  conditional: 'conditional',
  value: 'workValue',
  create: 'createAction',

  'delivery-health': 'health',
  release: 'release',
  risk: 'risk',
  spec: 'spec',
  full: 'full',
  intake: 'intake',
  planning: 'planning',
  'implementation-risk': 'implementationRisk',
  'test-impact': 'testImpact',
  'review-scope': 'reviewScope',
  'release-readiness': 'releaseReadiness',
  'spec-delta': 'specDelta',
  planned: 'planned',
  running: 'running',
  completed: 'completed',
  'completed-with-errors': 'completedErrors',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  pending: 'pending',
  returned: 'returned',
  failed: 'failed',
  stale: 'outdated',
  healthy: 'healthy',
  'attention-required': 'attention',
  blocked: 'blocked',
  incomplete: 'incomplete',
  unavailable: 'unavailable',
  propose: 'propose',
  continue: 'continue',
  'needs-information': 'needsInfo',
  'manual-review': 'manual',
  reject: 'rejectDecision',
  review: 'review',
  accepted: 'accepted',
  rejected: 'rejected',
  created: 'created',
  blocking: 'blocking',
  warning: 'warning',
  info: 'info',
}
export function label(value: string, t: Translate): string {
  const key = labels[value]
  return key === undefined ? value : t(key)
}
export const profiles: readonly AuditProfile[] = ['delivery-health', 'release', 'risk', 'spec', 'full']
const hints: Record<AuditProfile, Key> = {
  'delivery-health': 'healthHint',
  release: 'releaseHint',
  risk: 'riskHint',
  spec: 'specHint',
  full: 'fullHint',
}
export function profileHint(value: AuditProfile, t: Translate): string {
  return t(hints[value])
}
export function assessmentLabel(value: AssessmentKind, t: Translate): string {
  return label(value, t)
}
export function resumable(status: string): boolean {
  return ['interrupted', 'cancelled', 'completed-with-errors'].includes(status)
}
/** Classify a provider failure for the reader; an unknown code shows verbatim rather than pretending a category. */
export function providerError(code: string | undefined, t: Translate): string {
  const keys: Readonly<Record<string, Key>> = {
    JEV_INVALID_REQUEST: 'errInvalidRequest',
    JEV_CREDENTIAL_MISSING: 'errCredentialMissing',
    JEV_UNAVAILABLE: 'errUnreachable',
    JEV_TIMEOUT: 'errTimeout',
    JEV_RATE_LIMITED: 'errRateLimited',
    JEV_HTTP_ERROR: 'errHttp',
    JEV_BAD_RESPONSE: 'errBadResponse',
    JEV_ABORTED: 'cancelled',
  }
  if (code === undefined) return t('unavailable')
  const key = keys[code]
  return key === undefined ? code : t(key)
}
export function tone(status: string): string {
  if (['failed', 'unavailable', 'blocked', 'blocking', 'completed-with-errors'].includes(status)) return 'danger'
  if (['interrupted', 'manual-review', 'needs-information', 'stale', 'attention-required', 'warning'].includes(status))
    return 'warning'
  if (['running', 'propose'].includes(status)) return 'accent'
  return 'neutral'
}
export function date(value: string): string {
  const result = new Date(value)
  return Number.isNaN(result.getTime()) ? value : result.toLocaleString()
}
export function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function questionLabel(value: string, t: Translate): string {
  return value === 'risk' ? t('workRisk') : label(value, t)
}

/** The raw judgement in one line — what the list shows instead of decision vocabulary. */
export function judgementHeadline(
  keyAnswers: { value?: number; risk?: number; action?: string; actionProbability?: number } | undefined,
  t: Translate,
): string | undefined {
  if (keyAnswers === undefined) return undefined
  const parts = [
    ...keyAnswers.value === undefined ? [] : [`${t('workValue')} ${keyAnswers.value.toFixed(1)}/4`],
    ...keyAnswers.risk === undefined ? [] : [`${t('workRisk')} ${keyAnswers.risk.toFixed(1)}/4`],
    ...keyAnswers.action === undefined ? [] : [`${label(keyAnswers.action, t)} ${percent(keyAnswers.actionProbability ?? 0)}`],
  ]
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Translate machine-generated rubric reasons while retaining provider prose verbatim. */
export function reasonText(value: string, t: Translate): string {
  const match = /^(code-solvable|information|value|risk|confidence) ([0-9.]+|unavailable)$/.exec(value)
  if (match === null) return value
  const keys = {
    'code-solvable': 'codeSolvable',
    information: 'informationSufficient',
    value: 'workValue',
    risk: 'workRisk',
    confidence: 'confidence',
  } satisfies Record<string, Key>
  // The anchored expression admits exactly the five keys above.
  const kind = match[1] as keyof typeof keys
  const key = keys[kind]
  const numeric = Number(match[2])
  return `${t(key)} · ${Number.isFinite(numeric) ? (['value', 'risk'].includes(kind) ? `${numeric} / 4` : percent(numeric)) : t('unavailable')}`
}

/** Delivery records stay visible even when a historical action is no longer useful. */
export function assistanceDiagnostic(value: AssistanceRecord): boolean {
  return value.status !== 'delivered' && value.status !== 'delivering'
    && (value.status !== 'observed' || value.action === 'continue')
}
export function assistanceTitle(value: AssistanceRecord, t: Translate): string {
  const title = value.card?.title.trim()
  if (title) return title
  const id = value.sessionId.length > 16 ? value.sessionId.slice(0, 8) + '…' + value.sessionId.slice(-4) : value.sessionId
  return t('session') + ' · ' + id
}
export function assistanceAction(value: AssistanceRecord, t: Translate): string {
  if (value.status === 'stale') return t('adviceInvalidated')
  if (['cancelled', 'unavailable', 'budget-exhausted'].includes(value.status)) return t('noUsableAdvice')
  return value.action === 'continue' ? t('noIntervention') : label(value.action, t)
}
export function assistanceOutcome(value: AssistanceRecord, t: Translate): string {
  return assistanceDiagnostic(value) ? assistanceAction(value, t) : label(value.outcome, t)
}
export function assistanceModeHint(mode: AssistanceMode | undefined, t: Translate): string {
  if (mode === undefined) return t('loadError')
  const hints: Record<AssistanceMode, Key> = { off: 'modeOffHint', observe: 'modeObserveHint', assist: 'modeAssistHint' }
  return label(mode, t) + ' · ' + t(hints[mode])
}
export function assistanceDecisionReason(reason: NonNullable<AssistanceRecord['decisionReason']>, t: Translate): string {
  const labels: Record<typeof reason, Key> = { 'no-intervention': 'noIntervention', 'below-threshold': 'belowThreshold', actionable: 'actionableAdvice' }
  return t(labels[reason])
}
export function assistanceStaleReason(reason: string, t: Translate): string {
  const labels: Readonly<Record<string, Key>> = { 'provider-changed': 'staleProvider', 'activity-changed': 'staleActivity', 'evidence-changed': 'staleEvidence', 'task-changed': 'staleTask', 'workspace-changed': 'staleWorkspace', 'tools-changed': 'staleTools' }
  const key = labels[reason]
  return key === undefined ? reason : t(key)
}

export function assistanceExplanation(value: AssistanceRecord, t: Translate): string {
  return value.status === 'stale' ? t('invalidatedHint') : value.reason
}
export function assistanceAssociationReason(reason: string, t: Translate): string {
  const labels: Readonly<Record<string, Key>> = { 'no-card-observed': 'noCardObserved', 'multiple-cards-observed': 'multipleCardsObserved', 'board-unavailable': 'boardUnavailable', 'unsafe-board': 'unsafeBoard', 'card-unavailable': 'cardUnavailable', 'foreign-owner': 'foreignOwner', 'inactive-card': 'inactiveCard', 'unverified-worktree': 'unverifiedWorktree' }
  const key = labels[reason]
  return key === undefined ? reason : t(key)
}
