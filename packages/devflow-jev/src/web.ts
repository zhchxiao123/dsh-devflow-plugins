/* oxlint-disable @stylistic/max-len */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { AssessmentKind, AuditProfile } from './types.ts'
import { ASSESSMENT_KINDS } from './types.ts'
export type WebRequest = { method: 'list' | 'audit-list'; sessionId: string } | { method: 'read'; sessionId: string; id: string } | { method: 'accept' | 'reject'; sessionId: string; id: string } | { method: 'assess'; sessionId: string; title: string; body: string; assessmentKind?: AssessmentKind } | { method: 'audit-read' | 'audit-resume' | 'audit-cancel'; sessionId: string; runId: string } | { method: 'audit-start'; sessionId: string; profile?: AuditProfile; maxCards?: number }
async function scopeForSession(ctx: Context, raw: string): Promise<{ root: string; owner?: Agent }> {
  const id = raw as SessionId; const live = ctx.get('sessions')?.get(id)
  const cwd = live?.header.cwd
  const snapshot = cwd === undefined ? await ctx.get('sessionPersistence')?.stat(id) : undefined
  const project = cwd ?? snapshot?.header.cwd
  if (project === undefined) throw new Error(snapshot === undefined ? 'SESSION_NOT_FOUND' : 'PROJECT_CONTEXT_REQUIRED')
  const owner = ctx.get('agents')?.get(id)
  return { root: join(project, '.devflow'), ...(owner === undefined ? {} : { owner }) }
}
function requireOwner(owner: Agent | undefined): Agent { if (owner === undefined) throw new Error('LIVE_SESSION_REQUIRED: start, resume, and cancel require the live owning agent'); return owner }
function valid(value: unknown): value is WebRequest {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'method') !== 'string' || typeof Reflect.get(value, 'sessionId') !== 'string') return false
  const method: unknown = Reflect.get(value, 'method')
  if (method === 'list' || method === 'audit-list') return true
  if (method === 'read' || method === 'accept' || method === 'reject') return typeof Reflect.get(value, 'id') === 'string'
  if (method === 'audit-read' || method === 'audit-resume' || method === 'audit-cancel') return typeof Reflect.get(value, 'runId') === 'string'
  if (method === 'audit-start') { const profile: unknown = Reflect.get(value, 'profile'); const maxCards: unknown = Reflect.get(value, 'maxCards'); return (profile === undefined || (typeof profile === 'string' && ['delivery-health', 'release', 'risk', 'spec', 'full'].includes(profile))) && (maxCards === undefined || typeof maxCards === 'number') }
  if (method !== 'assess') return false
  const kind: unknown = Reflect.get(value, 'assessmentKind')
  return typeof Reflect.get(value, 'title') === 'string' && typeof Reflect.get(value, 'body') === 'string' && (kind === undefined || ASSESSMENT_KINDS.includes(kind as AssessmentKind))
}
function startAudit(ctx: Context, root: string, runId: string, resume: boolean, owner: Agent): string {
  const jobs = ctx.get('jobs'); if (jobs === undefined) throw new Error('JOBS_UNAVAILABLE')
  return jobs.start({ kind: 'jev-audit', owner, label: `JEV project audit ${runId}`, run: () => { const controller = new AbortController(); let output = ''
    const progress = (value: string) => { output = (output + value + '\n').slice(-65536) }
    const operation = resume ? ctx.devflowJev.resumeAudit(root, runId, controller.signal, progress) : ctx.devflowJev.runAudit(root, runId, controller.signal, progress)
    const done: Promise<JobOutcome> = operation.then(value => ({ status: controller.signal.aborted ? 'killed' as const : 'completed' as const, output: JSON.stringify(value) }), (error: unknown) => ({ status: controller.signal.aborted ? 'killed' as const : 'failed' as const, output: error instanceof Error ? error.message : String(error) }))
    return { cancel: () => { controller.abort() }, done, readOutput: () => { const value = output; output = ''; return value } }
  } })
}
async function body(req: IncomingMessage): Promise<WebRequest> {
  const chunks: Buffer[] = []; let size = 0
  for await (const part of req) { const chunk = part as Buffer; size += chunk.byteLength; if (size > 64 * 1024) throw new Error('body-too-large'); chunks.push(chunk) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!valid(value)) throw new Error('invalid-request'); return value
}
function respond(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }); res.end(JSON.stringify(value)) }
function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
function trusted(req: IncomingMessage): boolean {
  const host = req.headers.host; if (host === undefined || req.headers['sec-fetch-site'] === 'cross-site') return false
  let authority: URL
  try { authority = new URL(`http://${host}`) } catch { return false }
  if (!loopback(authority.hostname)) return false
  const origin = req.headers.origin; if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}
export function registerWeb(ctx: Context): () => void {
  return ctx.webServer.register({ kind: 'exact', path: '/devflow/jev/api', handler: async (req, res) => {
    if (!trusted(req)) { respond(res, 403, { ok: false, error: 'forbidden' }); return }
    if (req.method !== 'POST') { respond(res, 405, { ok: false, error: 'post-required' }); return }
    let request: WebRequest
    try { request = await body(req) } catch { respond(res, 400, { ok: false, error: 'invalid-request' }); return }
    try {
      const { root, owner } = await scopeForSession(ctx, request.sessionId)
      switch (request.method) {
        case 'list': respond(res, 200, { ok: true, data: await ctx.devflowJev.list(root) }); break
        case 'audit-list': respond(res, 200, { ok: true, data: await ctx.devflowJev.listAudits(root) }); break
        case 'audit-read': respond(res, 200, { ok: true, data: await ctx.devflowJev.inspectAudit(root, request.runId) }); break
        case 'audit-start': { const liveOwner = requireOwner(owner); const prepared = await ctx.devflowJev.prepareAudit({ root, ...(request.profile === undefined ? {} : { profile: request.profile }), ...(request.maxCards === undefined ? {} : { maxCards: request.maxCards }) }); const jobId = startAudit(ctx, root, prepared.manifest.id, false, liveOwner); await ctx.devflowJev.bindAuditJob(root, prepared.manifest.id, jobId); respond(res, 200, { ok: true, data: { ...prepared, jobId } }); break }
        case 'audit-resume': { const jobId = startAudit(ctx, root, request.runId, true, requireOwner(owner)); await ctx.devflowJev.bindAuditJob(root, request.runId, jobId); respond(res, 200, { ok: true, data: { runId: request.runId, jobId } }); break }
        case 'audit-cancel': { const audit = await ctx.devflowJev.inspectAudit(root, request.runId); if (audit.state.jobId === undefined) throw new Error('AUDIT_JOB_NOT_FOUND'); const jobs = ctx.get('jobs'); if (jobs === undefined) throw new Error('JOBS_UNAVAILABLE'); respond(res, 200, { ok: true, data: { runId: request.runId, outcome: jobs.kill(JobId(audit.state.jobId), requireOwner(owner), 'project audit cancelled from web') } }); break }
        case 'read': respond(res, 200, { ok: true, data: await ctx.devflowJev.read(root, request.id) }); break
        case 'accept': respond(res, 200, {
          ok: true,
          data: await ctx.devflowJev.accept(root, request.id, { kind: 'human', name: `web:${req.headers.host ?? 'local'}` }),
        }); break
        case 'reject': respond(res, 200, { ok: true, data: await ctx.devflowJev.reject(root, request.id) }); break
        case 'assess': respond(res, 200, {
          ok: true,
          data: await ctx.devflowJev.assessRequest({
            root, title: request.title, body: request.body,
            ...(request.assessmentKind === undefined ? {} : { assessmentKind: request.assessmentKind }),
          }),
        }); break
      }
    } catch (error: unknown) { respond(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  } })
}
