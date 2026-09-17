import type { Plan, PlanInput, Trigger } from '@zhchxiao123/dsh-scheduler'
import type { Snapshot, StorageUsage, Subscription, SyncReceipt, SyncRun } from '@zhchxiao123/dsh-github-sync'
export interface Overview {
  project: { id: string; title: string }
  schedulerAvailable: boolean
  githubAvailable: boolean
  plans: Plan[]
  triggers: Trigger[]
  subscriptions: Subscription[]
  runs: SyncRun[]
  storage: StorageUsage | null
}
export interface SubscriptionForm {
  repository: string
  issues: boolean
  discussions: boolean
  credentialRef?: string
}
export type AutomationRequest = { sessionId: string } & (
  | { method: 'overview' }
  | { method: 'content'; subscriptionId: string }
  | { method: 'plan.save'; id?: string; input: Omit<PlanInput, 'projectId'> }
  | { method: 'plan.action'; id: string; action: 'pause' | 'resume' | 'remove' | 'trigger' | 'cancel' }
  | { method: 'subscription.save'; id?: string; input: SubscriptionForm }
  | { method: 'subscription.action'; id: string; action: 'pause' | 'resume' | 'sync' }
  | { method: 'run.action'; id: string; action: 'cancel' | 'resume' }
  | { method: 'capacity.set'; bytes: number }
  | { method: 'unassigned' }
  | { method: 'claim'; kind: 'plan' | 'subscription'; id: string }
)
export type AutomationResult<T extends AutomationRequest> =
  T extends { method: 'unassigned' } ? { plans: Plan[]; subscriptions: Subscription[] } :
    T extends { method: 'claim' } ? Plan | Subscription :
      T extends { method: 'overview' } ? Overview :
        T extends { method: 'content' } ? Snapshot[] :
          T extends { method: 'plan.save' } ? Plan :
            T extends { method: 'plan.action' } ? Trigger | null :
              T extends { method: 'subscription.save' } ? Subscription :
                T extends { method: 'subscription.action' } ? Subscription | SyncReceipt :
                  T extends { method: 'run.action' } ? SyncReceipt | null : StorageUsage
