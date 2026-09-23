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
