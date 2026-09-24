/* oxlint-disable @stylistic/max-len */
import type { Answer } from '@zhchxiao123/dsh-jev'
import type { CardLocation, DevflowJournalEntry, ServiceClass } from '@zhchxiao123/dsh-devflow'

export const ASSESSMENT_KINDS = ['intake', 'planning', 'implementation-risk', 'test-impact', 'review-scope', 'release-readiness', 'spec-delta'] as const
export type AssessmentKind = typeof ASSESSMENT_KINDS[number]
export type EvaluationDecision = 'propose' | 'continue' | 'needs-information' | 'manual-review' | 'reject' | 'unavailable'
export type EvaluationStatus = 'review' | 'accepted' | 'rejected' | 'created' | 'unavailable'
export interface RequestSubject { readonly kind: 'request'; readonly title: string; readonly body: string; readonly digest: string }
export interface CardSubject { readonly kind: 'card'; readonly cardId: string; readonly title: string; readonly stage: CardLocation; readonly stageRevision: number; readonly digest: string }
export type EvaluationSubject = RequestSubject | CardSubject
export interface EvaluationRecord {
  readonly id: string
  readonly root: string
  readonly subject: EvaluationSubject
  readonly assessmentKind: AssessmentKind
  readonly rubricVersion: string
  readonly status: EvaluationStatus
  readonly decision: EvaluationDecision
  readonly confidence: number
  readonly answers: Readonly<Record<string, Answer>>
  readonly reasons: readonly string[]
  readonly missingInformation: readonly string[]
  readonly recommendedServiceClass: ServiceClass
  readonly proposedTitle?: string
  readonly proposedBody?: string
  readonly createdCardId?: string
  readonly providerModel?: string
  readonly evidenceDigest?: string
  readonly evidence?: CardEvidence
  readonly error?: { readonly code: string; readonly message: string }
  readonly createdAt: string
  readonly decidedAt?: string
}

export type AuditProfile = 'delivery-health' | 'release' | 'risk' | 'spec' | 'full'
export type AuditRunStatus = 'planned' | 'running' | 'completed' | 'completed-with-errors' | 'cancelled' | 'interrupted'
export type AuditConclusion = 'healthy' | 'attention-required' | 'blocked' | 'incomplete' | 'unavailable'
export interface EvidenceGap { readonly kind: 'missing' | 'unsafe' | 'oversized' | 'unreadable'; readonly path: string; readonly detail: string }
export interface EvidenceArtifact { readonly path: string; readonly kind?: string; readonly digest: string; readonly excerpt: string; readonly truncated: boolean }
export interface EvidenceRelation { readonly id: string; readonly title: string; readonly stage: CardLocation; readonly stageRevision: number }
export interface CardEvidence {
  readonly card: { readonly id: string; readonly title: string; readonly body: string; readonly stage: CardLocation; readonly stageRevision: number; readonly serviceClass: ServiceClass; readonly parent?: string }
  readonly journal: readonly DevflowJournalEntry[]
  readonly artifacts: readonly EvidenceArtifact[]
  readonly gaps: readonly EvidenceGap[]
  readonly relations: { readonly parent?: EvidenceRelation; readonly children: readonly EvidenceRelation[] }
}
export interface AuditCheck {
  readonly id: string
  readonly cardId: string
  readonly cardTitle: string
  readonly stage: CardLocation
  readonly stageRevision: number
  readonly assessmentKind: AssessmentKind
  readonly evidenceDigest: string
  readonly rubricVersion: string
}
export interface AuditManifest {
  readonly id: string
  readonly root: string
  readonly profile: AuditProfile
  readonly createdAt: string
  readonly checks: readonly AuditCheck[]
  readonly cardCount: number
}
export interface AuditCheckResult { readonly check: AuditCheck; readonly status: 'completed' | 'failed' | 'stale' | 'cancelled'; readonly evaluationId?: string; readonly error?: string; readonly completedAt: string }
export interface AuditFinding { readonly severity: 'info' | 'warning' | 'blocking'; readonly code: string; readonly message: string; readonly cardId?: string }
export interface AuditState {
  readonly runId: string
  readonly status: AuditRunStatus
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly results: readonly AuditCheckResult[]
  readonly findings: readonly AuditFinding[]
  readonly conclusion?: AuditConclusion
  readonly createdAt: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly jobId?: string
}
export interface AuditSummary { readonly manifest: AuditManifest; readonly state: AuditState }
export interface AuditRequest { readonly root: string; readonly profile?: AuditProfile; readonly maxCards?: number }
/**
 * Decision floors, separated by the answer type they read: Noul answers are
 * thresholded on their probability alone, Choice and Score answers on their
 * distribution `confidence`. The two scales are not interchangeable — the same
 * question asked as a Noul and as a Choice yields structurally different
 * numbers — so no floor here may ever gate an answer of the other type.
 */
export interface AssessmentPolicy {
  readonly codeSolvableFloor: number
  readonly informationFloor: number
  readonly valueFloor: number
  /** Concentration floor for a consumed Choice distribution. */
  readonly choiceConfidenceFloor: number
  /** Concentration floor for a consumed Score distribution. */
  readonly scoreConfidenceFloor: number
  readonly maximumRisk: number
}
export interface AssessmentInput {
  readonly root: string
  readonly title: string
  readonly body: string
  readonly assessmentKind?: AssessmentKind
}
export interface CardAssessmentInput { readonly root: string; readonly cardId: string; readonly assessmentKind: AssessmentKind }
export interface EvaluationSummary {
  readonly id: string
  readonly subject: EvaluationSubject
  readonly assessmentKind: AssessmentKind
  readonly status: EvaluationStatus
  readonly decision: EvaluationDecision
  readonly confidence: number
  readonly reasons: readonly string[]
  readonly createdAt: string
  readonly createdCardId?: string
}
export function summarizeEvaluation(record: EvaluationRecord): EvaluationSummary {
  return { id: record.id, subject: record.subject, assessmentKind: record.assessmentKind, status: record.status,
    decision: record.decision, confidence: record.confidence, reasons: record.reasons, createdAt: record.createdAt,
    ...(record.createdCardId === undefined ? {} : { createdCardId: record.createdCardId }) }
}
