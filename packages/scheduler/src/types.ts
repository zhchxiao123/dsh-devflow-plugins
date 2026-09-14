/** Durable plans use UTC epoch milliseconds; cron interpretation uses the supplied IANA zone. */
export type TimeRule = { kind: 'interval'; everyMs: number } | { kind: 'cron'; expression: string; timezone: string }
export interface PlanInput {
  projectId: string
  name: string
  handler: string
  params: unknown
  rule: TimeRule
  misfire?: 'latest' | 'skip'
  maxAttempts?: number
  timeoutMs?: number
}
export interface Plan extends Omit<PlanInput, 'projectId'> {
  projectId: string | null
  id: string
  enabled: boolean
  deleted: boolean
  nextAt: number
  createdBy: string
  updatedBy: string
}
export type TriggerState = 'pending' | 'delivering' | 'accepted' | 'completed' | 'failed' | 'cancelled' | 'partial'
export interface Trigger {
  projectId: string | null
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
  projectId: string
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
  validate(params: unknown, projectId: string): void | Promise<void>
  accept(delivery: Delivery): Promise<{ runId: string }>
  status(runId: string, projectId?: string): Promise<RunStatus>
  cancel(runId: string, projectId?: string): Promise<void>
}
