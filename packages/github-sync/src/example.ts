/** A consumer's external side effect must deduplicate by change.id before acknowledging. */
import type GitHubSync from './index.ts'
import type { Change } from './types.ts'
export async function consumePage(
  sync: GitHubSync,
  subscriptionId: string,
  consumerId: string,
  limit: number,
  handle: (change: Change) => Promise<void>,
  projectId: string,
): Promise<number> {
  await sync.registerConsumer(subscriptionId, consumerId, 'beginning', projectId)
  const changes = await sync.readChanges(subscriptionId, consumerId, limit, projectId)
  for (const change of changes) {
    await handle(change)
    await sync.acknowledge(subscriptionId, consumerId, change.sequence, projectId)
  }
  return changes.length
}
