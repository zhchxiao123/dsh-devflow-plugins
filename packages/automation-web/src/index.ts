/** Project-scoped automation projection. Services own durable state and lifecycle. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@zhchxiao123/dsh-scheduler'
import type {} from '@zhchxiao123/dsh-github-sync'
import { assertTrustedAuthority, isTrustedRequest } from './request-trust.ts'
import { resolveSessionProject } from '@zhchxiao123/dsh-automation-project'
import { publicError } from './errors.ts'
import { requestSchema } from './schema.ts'
import type { AutomationRequest } from './types.ts'
export type * from './types.ts'
export const name = 'automation-web'
export const inject = ['webServer']
export interface Config { trustedHosts: string[] }
export const Config: z<Config> = z.object({ trustedHosts: z.array(String).default([]) })
/** Security bound: management requests must not pin unbounded memory. */
const MAX_BODY_BYTES = 64 * 1024
async function readBody(req: IncomingMessage): Promise<AutomationRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  // JSON cannot contain explicit undefined; optional schema fields are absent on this wire.
  return requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) as AutomationRequest
}
async function dispatch(ctx: Context, request: AutomationRequest, actor: string): Promise<unknown> {
  const project = await resolveSessionProject(ctx, request.sessionId)
  const scheduler = ctx.get('scheduler')
  const github = ctx.get('githubSync')
  if (request.method === 'overview') {
    const [plans, triggers, subscriptions, runs, storage] = await Promise.all([
      scheduler?.list(project.id) ?? [], scheduler?.history(undefined, project.id) ?? [],
      github?.subscriptions(project.id) ?? [], github?.runs(undefined, project.id) ?? [], github?.storage() ?? null,
    ])
    return { project, schedulerAvailable: scheduler !== undefined, githubAvailable: github !== undefined,
      plans, triggers, subscriptions, runs, storage }
  }
  switch (request.method) {
    case 'unassigned':
      return { plans: await scheduler?.listUnassigned() ?? [], subscriptions: await github?.unassignedSubscriptions() ?? [] }
    case 'claim':
      if (request.kind === 'plan') {
        if (scheduler === undefined) throw new Error('scheduler-unavailable')
        return scheduler.claimPlan(request.id, project.id, actor)
      }
      if (github === undefined) throw new Error('github-sync-unavailable')
      return github.claimSubscription(request.id, project.id, actor)
    case 'plan.save':
      if (scheduler === undefined) throw new Error('scheduler-unavailable')
      return request.id === undefined ? scheduler.create({ ...request.input, projectId: project.id }, actor)
        : scheduler.update(request.id, { ...request.input, projectId: project.id }, actor, project.id)
    case 'plan.action':
      if (scheduler === undefined) throw new Error('scheduler-unavailable')
      return scheduler[request.action](request.id, actor, project.id)
    case 'content':
      if (github === undefined) throw new Error('github-sync-unavailable')
      return github.snapshots(request.subscriptionId, project.id)
    case 'subscription.save': {
      if (github === undefined) throw new Error('github-sync-unavailable')
      if (request.id === undefined) return github.createSubscription({ ...request.input, actor, projectId: project.id })
      const current = (await github.subscriptions(project.id)).find(item => item.id === request.id)
      if (current === undefined || current.repository !== request.input.repository) throw new Error('subscription-repository-mismatch')
      return github.updateSubscription(request.id, { ...request.input, actor }, project.id)
    }
    case 'subscription.action':
      if (github === undefined) throw new Error('github-sync-unavailable')
      return request.action === 'sync' ? github.sync(request.id, { actor }, project.id) : github.updateSubscription(request.id, { paused: request.action === 'pause', actor }, project.id)
    case 'run.action':
      if (github === undefined) throw new Error('github-sync-unavailable')
      return request.action === 'resume' ? github.resumeRun(request.id, actor, project.id) : github.cancel(request.id, actor, project.id)
    case 'capacity.set':
      if (github === undefined) throw new Error('github-sync-unavailable')
      return github.setCapacity(request.bytes, actor)
  }
}
function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
export function apply(ctx: Context, config: Config): void {
  for (const host of config.trustedHosts) assertTrustedAuthority(host)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/automation/api', handler: async (req, res) => {
      if (!isTrustedRequest(req, config.trustedHosts)) { respond(res, 403, { ok: false, error: 'forbidden' })
        return }
      if (req.method !== 'POST') { respond(res, 405, { ok: false, error: 'post-required' })
        return }
      let request: AutomationRequest
      try { request = await readBody(req) }
      catch { respond(res, 400, { ok: false, error: 'invalid-request' })
        return }
      // Same-origin host requests represent the human management plane. The body cannot forge this actor.
      const actor = `web:${req.headers.host}`
      try { respond(res, 200, { ok: true, data: await dispatch(ctx, request, actor) ?? null }) }
      catch (error) { respond(res, 200, { ok: false, error: publicError(error) }) }
    },
  }), 'automation management route')
}
