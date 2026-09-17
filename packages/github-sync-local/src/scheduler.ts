/** Optional schedule consumer; GitHub sync remains usable without a scheduler. */
import type { Context } from '@deepseek-ai/cordis'
import type { GitHubSync, SyncRun } from '@zhchxiao123/dsh-github-sync'
import type { RunStatus } from '@zhchxiao123/dsh-scheduler'

const RUN_STATES: Record<SyncRun['status'], RunStatus['state']> = {
  queued: 'running', running: 'running', waiting: 'running', succeeded: 'completed',
  partial: 'partial', failed: 'failed', cancelled: 'cancelled',
}

function subscriptionId(params: unknown): string {
  if (
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    !('subscriptionId' in params) ||
    typeof params.subscriptionId !== 'string' ||
    params.subscriptionId.trim().length === 0 ||
    Object.keys(params).some(key => key !== 'subscriptionId')
  ) {
    throw new Error('github.sync requires only a non-empty subscriptionId')
  }
  return params.subscriptionId
}

/**
 * Register only while both services are available; the injection fiber owns disposal.
 * @param ctx - provider context owning the optional registration.
 * @param sync - durable synchronization service accepting stable trigger IDs.
 */
export function installScheduler(ctx: Context, sync: GitHubSync): void {
  ctx.inject(['scheduler'], (scope) => {
    scope.effect(() =>
      scope.scheduler.registerHandler('github.sync', {
        async validate(params, projectId) {
          const id = subscriptionId(params)
          if (!(await sync.subscriptions(projectId)).some(value => value.id === id)) throw new Error('PROJECT_MISMATCH')
        },
        async accept(delivery) {
          delivery.signal.throwIfAborted()
          return sync.sync(subscriptionId(delivery.params), {
            triggerId: delivery.triggerId,
            actor: `scheduler:${delivery.planId}`,
            cancelRequested: delivery.cancelRequested,
          }, delivery.projectId)
        },
        async status(runId, projectId): Promise<RunStatus> {
          const run = await sync.run(runId, projectId)
          if (run === undefined) throw new Error('github-sync-run-not-found')
          const error = run.error === undefined ? {} : { error: run.error }
          return { state: RUN_STATES[run.status], ...error }
        },
        async cancel(runId, projectId) {
          await sync.cancel(runId, 'scheduler', projectId)
        },
      }),
    )
  })
}
