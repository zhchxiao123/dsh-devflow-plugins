import type { Overview } from '@zhchxiao123/dsh-automation-web/client'
import type { Subscription, SyncRun } from '@zhchxiao123/dsh-github-sync'
import type { Plan } from '@zhchxiao123/dsh-scheduler'
import { zh, type AutomationKey } from '../src/client/locales.ts'
export const t = (key: AutomationKey): string => zh[key]
export function subscription(id = 'sub'): Subscription {
  return { projectId: 'project-one', id, repository: `owner/${id}`, actor: 'test', issues: true, discussions: false, revision: 1, paused: false }
}
export function plan(id = 'plan'): Plan {
  return { projectId: 'project-one', id, name: `Schedule ${id}`, handler: 'github.sync', params: { subscriptionId: 'sub' }, rule: { kind: 'interval', everyMs: 120_000 }, enabled: true, deleted: false, nextAt: 1000, createdBy: 'test', updatedBy: 'test' }
}
export function run(id = 'run'): SyncRun {
  return { id, subscriptionId: 'sub', subscriptionSnapshot: subscription(), triggerId: 'trigger', actor: 'test', acceptedAt: 1000, status: 'running', checkpointSequence: 1, pageBudget: 100, pages: 2, objects: 4, retries: 1, fence: 1, leaseUntil: 1000, owner: 'test', reconcile: false }
}
export function overview(): Overview {
  return { project: { id: 'project-one', title: 'Project One' }, schedulerAvailable: true, githubAvailable: true, plans: [plan()],
    subscriptions: [subscription()], runs: [run()], triggers: [], storage: { bytes: 200, capacityBytes: 1000, blocked: false } }
}
