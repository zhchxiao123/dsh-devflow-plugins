/** GitHub input is untrusted content, never executable policy. */
export type ContentKind =
  | 'issue'
  | 'issue-comment'
  | 'discussion'
  | 'discussion-comment'
  | 'discussion-reply'
export interface SubscriptionInput {
  projectId: string
  repository: string
  credentialRef?: string
  issues: boolean
  discussions: boolean
  actor: string
}
export interface Subscription extends Omit<SubscriptionInput, 'projectId'> {
  projectId: string | null
  id: string
  paused: boolean
  revision: number
  lastSuccessAt?: number
  lastReconcileAt?: number
}
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
export interface SyncRun {
  subscriptionSnapshot: Subscription
  id: string
  subscriptionId: string
  triggerId: string
  actor: string
  acceptedAt: number
  status: RunStatus
  checkpointSequence: number
  pageBudget: number
  pages: number
  objects: number
  retries: number
  fence: number
  leaseUntil: number
  owner: string
  reconcile: boolean
  completedAt?: number
  error?: string
  waitUntil?: number
}
export interface SyncReceipt {
  runId: string
  acceptedAt: number
}
export interface SyncRequest {
  cancelRequested?: boolean
  triggerId?: string
  actor: string
  reconcile?: boolean
}
export interface Snapshot {
  id: string
  subscriptionId: string
  kind: ContentKind
  parentId?: string
  url: string
  updatedAt: string
  title: string
  body: string
  state: string
  version: number
  fingerprint: string
  fetchedAt: number
  deleted: boolean
}
export interface Change {
  sequence: number
  id: string
  subscriptionId: string
  objectId: string
  version: number
  type: 'created' | 'updated' | 'deleted'
  snapshot: Snapshot
}
export interface StorageUsage {
  bytes: number
  capacityBytes: number
  blocked: boolean
  error?: string
  capacityChangedBy?: string
  capacityChangedAt?: number
}
