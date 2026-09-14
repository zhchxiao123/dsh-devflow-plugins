/** Durable plans use UTC epoch milliseconds; cron interpretation uses the supplied IANA zone. */
export type TimeRule = { kind: 'interval'; everyMs: number } | { kind: 'cron'; expression: string; timezone: string }
export interface PlanInput {
  name: string
  handler: string
  params: unknown
  rule: TimeRule
  misfire?: 'latest' | 'skip'
  maxAttempts?: number
  timeoutMs?: number
}
export interface Plan extends PlanInput {
  id: string
  enabled: boolean
  deleted: boolean
  nextAt: number
  createdBy: string
  updatedBy: string
}
export type TriggerState = 'pending' | 'delivering' | 'accepted' | 'completed' | 'failed' | 'cancelled' | 'partial'
export interface Trigger {
  id: string
  planId: string
  scheduledAt: number
  state: TriggerState
  attempts: number
  runId?: string
  error?: string
  acceptedAt?: number
  completedAt?: number
  requestedBy: string
}
export interface Delivery {
  /** Atomically cancel an existing run or persist a cancellation tombstone; never start new work. */
  cancelRequested: boolean
  triggerId: string
  planId: string
  params: unknown
  signal: AbortSignal
}
export interface RunStatus {
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'partial'
  error?: string
}
export interface ScheduleHandler {
  validate(params: unknown): void
  accept(delivery: Delivery): Promise<{ runId: string }>
  status(runId: string): Promise<RunStatus>
  cancel(runId: string): Promise<void>
}
