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
  abstract createSubscription(input: SubscriptionInput): Promise<Subscription>
  abstract updateSubscription(
    id: string,
    patch: Partial<SubscriptionInput> & { paused?: boolean; actor: string },
  ): Promise<Subscription>
  abstract subscriptions(): Promise<Subscription[]>
  abstract sync(
    subscriptionId: string,
    request: SyncRequest,
  ): Promise<SyncReceipt>
  abstract resumeRun(runId: string, actor: string): Promise<SyncReceipt>
  abstract run(runId: string): Promise<SyncRun | undefined>
  abstract runs(subscriptionId?: string): Promise<SyncRun[]>
  abstract cancel(runId: string, actor: string): Promise<void>
  abstract snapshots(subscriptionId: string): Promise<Snapshot[]>
  abstract registerConsumer(
    subscriptionId: string,
    consumerId: string,
    from: 'beginning' | 'now',
  ): Promise<void>
  abstract readChanges(
    subscriptionId: string,
    consumerId: string,
    limit: number,
  ): Promise<Change[]>
  abstract acknowledge(
    subscriptionId: string,
    consumerId: string,
    sequence: number,
  ): Promise<void>
  abstract replay(
    subscriptionId: string,
    consumerId: string,
    from: 'beginning' | 'now',
  ): Promise<void>
  abstract consumerState(
    subscriptionId: string,
    consumerId: string,
  ): Promise<{ acknowledged: number; delivered: number }>
  abstract setCapacity(bytes: number, actor: string): Promise<StorageUsage>
  abstract watch(subscriptionId: string, listener: () => void): () => void
  abstract storage(): Promise<StorageUsage>
}
export default GitHubSync
export { consumePage } from './example.ts'
