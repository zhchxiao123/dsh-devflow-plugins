import type { Plan, PlanInput, Trigger } from '@zhchxiao123/dsh-scheduler'
import type { Snapshot, StorageUsage, Subscription, SyncReceipt, SyncRun } from '@zhchxiao123/dsh-github-sync'
export interface Overview {
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
export type AutomationRequest =
  | { method: 'overview' }
  | { method: 'content'; subscriptionId: string }
  | { method: 'plan.save'; id?: string; input: PlanInput }
  | { method: 'plan.action'; id: string; action: 'pause' | 'resume' | 'remove' | 'trigger' | 'cancel' }
  | { method: 'subscription.save'; id?: string; input: SubscriptionForm }
  | { method: 'subscription.action'; id: string; action: 'pause' | 'resume' | 'sync' }
  | { method: 'run.action'; id: string; action: 'cancel' | 'resume' }
  | { method: 'capacity.set'; bytes: number }
export type AutomationResult<T extends AutomationRequest> =
  T extends { method: 'overview' } ? Overview :
    T extends { method: 'content' } ? Snapshot[] :
      T extends { method: 'plan.save' } ? Plan :
        T extends { method: 'plan.action' } ? Trigger | null :
          T extends { method: 'subscription.save' } ? Subscription :
            T extends { method: 'subscription.action' } ? Subscription | SyncReceipt :
              T extends { method: 'run.action' } ? SyncReceipt | null : StorageUsage
