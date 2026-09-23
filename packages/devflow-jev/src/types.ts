import type { Answer } from '@zhchxiao123/dsh-jev'
import type { CardLocation, ServiceClass } from '@zhchxiao123/dsh-devflow'

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
  readonly rubricVersion: '1'
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
  readonly error?: { readonly code: string; readonly message: string }
  readonly createdAt: string
  readonly decidedAt?: string
}
export interface AssessmentPolicy {
  readonly codeSolvableFloor: number
  readonly informationFloor: number
  readonly valueFloor: number
  readonly confidenceFloor: number
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
