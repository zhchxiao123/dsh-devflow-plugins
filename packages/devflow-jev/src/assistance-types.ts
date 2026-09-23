/** Durable assistance records are advice; they never attest gate or test acceptance. */
export type AssistanceMode = 'off' | 'observe' | 'assist'
export type AssistanceEvent = 'planning' | 'changed-code' | 'repeated-failure' | 'completion'
export type AssistanceAction = 'continue' | 'read-evidence' | 'revise-plan' | 'inspect-failure' | 'add-verification' | 'review-change'
export type AssistanceDecisionReason = 'no-intervention' | 'below-threshold' | 'actionable'
export type AssistanceStatus = 'observed' | 'delivering' | 'delivered' | 'stale' | 'cancelled' | 'unavailable' | 'budget-exhausted'
export type AssistanceOutcome = 'unknown' | 'action-observed' | 'check-passed' | 'check-failed'
export interface AssistanceConfig {
  readonly mode: AssistanceMode
  readonly timeoutMs: number
  readonly maxCallsPerTurn: number
  readonly maxSteersPerTurn: number
  readonly confidenceFloor: number
  readonly maxBytes: number
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly repeatThreshold: number
}
export interface AssistanceCard { readonly id: string; readonly revision: number; readonly stage: string; readonly title: string }
export interface AssistanceRecord {
  readonly id: string
  readonly workspace: string
  readonly sessionId: string
  readonly sessionTitle?: string
  readonly turn: number
  readonly card?: AssistanceCard
  readonly associationReason?: string
  readonly event: AssistanceEvent
  readonly mode: AssistanceMode
  readonly evidenceDigest: string
  readonly configurationStatus?: 'configured' | 'unconfigured' | 'unknown'
  readonly providerIdentity?: string
  readonly policyVersion: string
  readonly model?: string
  readonly action: AssistanceAction
  readonly rawAction?: AssistanceAction
  readonly decisionReason?: AssistanceDecisionReason
  readonly staleReasons?: readonly string[]
  readonly reason: string
  readonly evidenceRefs: readonly string[]
  readonly gaps: readonly string[]
  readonly actionConfidence?: number
  readonly justifiedProbability?: number
  readonly confidence: number
  readonly status: AssistanceStatus
  readonly outcome: AssistanceOutcome
  readonly outcomeDetail?: string
  readonly elapsedMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly createdAt: string
  readonly updatedAt: string
}
