/** Durable GitHub content seam; consumers own their processing and side effects. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  Change,
  Snapshot,
  StorageUsage,
  Subscription,
  SubscriptionInput,
  SyncReceipt,
  SyncRequest,
  SyncRun,
} from './types.ts'
export type * from './types.ts'
declare module '@deepseek-ai/cordis' {
  interface Context {
    githubSync: GitHubSync
  }
}
export abstract class GitHubSync extends Service {
  constructor(ctx: Context) {
    super(ctx, 'githubSync')
  }
  abstract unassignedSubscriptions(): Promise<Subscription[]>
  abstract claimSubscription(id: string, projectId: string, actor: string): Promise<Subscription>
  abstract createSubscription(input: SubscriptionInput): Promise<Subscription>
  abstract updateSubscription(
    id: string,
    patch: Partial<SubscriptionInput> & { paused?: boolean; actor: string },
    projectId?: string,
  ): Promise<Subscription>
  abstract subscriptions(projectId?: string): Promise<Subscription[]>
  abstract sync(
    subscriptionId: string,
    request: SyncRequest,
    projectId?: string,
  ): Promise<SyncReceipt>
  abstract resumeRun(runId: string, actor: string, projectId?: string): Promise<SyncReceipt>
  abstract run(runId: string, projectId?: string): Promise<SyncRun | undefined>
  abstract runs(subscriptionId?: string, projectId?: string): Promise<SyncRun[]>
  abstract cancel(runId: string, actor: string, projectId?: string): Promise<void>
  abstract snapshots(subscriptionId: string, projectId?: string): Promise<Snapshot[]>
  abstract registerConsumer(
    subscriptionId: string,
    consumerId: string,
    from: 'beginning' | 'now',
    projectId?: string,
  ): Promise<void>
  abstract readChanges(
    subscriptionId: string,
    consumerId: string,
    limit: number,
    projectId?: string,
  ): Promise<Change[]>
  abstract acknowledge(
    subscriptionId: string,
    consumerId: string,
    sequence: number,
    projectId?: string,
  ): Promise<void>
  abstract replay(
    subscriptionId: string,
    consumerId: string,
    from: 'beginning' | 'now',
    projectId?: string,
  ): Promise<void>
  abstract consumerState(
    subscriptionId: string,
    consumerId: string,
    projectId?: string,
  ): Promise<{ acknowledged: number; delivered: number }>
  abstract setCapacity(bytes: number, actor: string): Promise<StorageUsage>
  abstract watch(subscriptionId: string, listener: () => void, projectId?: string): () => void
  abstract storage(): Promise<StorageUsage>
}
export default GitHubSync
export { consumePage } from './example.ts'
