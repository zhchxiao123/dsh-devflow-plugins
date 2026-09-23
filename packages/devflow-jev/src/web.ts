import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@zhchxiao123/dsh-jev/runs-plugin'
import type { AssessmentKind, AuditProfile } from './types.ts'
import type {} from './assistance.ts'
import { ASSESSMENT_KINDS } from './types.ts'
export type WebRequest = { method: 'assistance-list'; sessionId: string } | { method: 'assistance-read'; sessionId: string; id: string } | { method: 'run-start'; sessionId: string; title?: string; evidence?: string; questions?: string[]; definitionJson?: string } | { method: 'assess-card'; sessionId: string; id: string; assessmentKind: AssessmentKind } | { method: 'context' | 'list' | 'audit-list'; sessionId: string } | { method: 'run-list'; sessionId: string } | { method: 'read'; sessionId: string; id: string } | { method: 'accept' | 'reject'; sessionId: string; id: string } | { method: 'assess'; sessionId: string; title: string; body: string; assessmentKind?: AssessmentKind } | { method: 'audit-read' | 'audit-resume' | 'audit-cancel' | 'run-read' | 'run-resume' | 'run-cancel'; sessionId: string; runId: string } | { method: 'audit-start'; sessionId: string; profile?: AuditProfile; maxCards?: number }
async function scopeForSession(ctx: Context, raw: string): Promise<{ root: string; project: string; owner?: Agent }> {
  const id = raw as SessionId; const live = ctx.get('sessions')?.get(id)
  const cwd = live?.header.cwd
  const snapshot = cwd === undefined ? await ctx.get('sessionPersistence')?.stat(id) : undefined
  const project = cwd ?? snapshot?.header.cwd
  if (project === undefined) throw new Error(snapshot === undefined ? 'SESSION_NOT_FOUND' : 'PROJECT_CONTEXT_REQUIRED')
  const owner = ctx.get('agents')?.get(id)
  return { root: join(project, '.devflow'), project, ...(owner === undefined ? {} : { owner }) }
}
function requireOwner(owner: Agent | undefined): Agent { if (owner === undefined) throw new Error('LIVE_SESSION_REQUIRED: start, resume, and cancel require the live owning agent'); return owner }
function valid(value: unknown): value is WebRequest {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'method') !== 'string' || typeof Reflect.get(value, 'sessionId') !== 'string') return false
  const method: unknown = Reflect.get(value, 'method')
  if (method === 'context' || method === 'list' || method === 'audit-list' || method === 'run-list' || method === 'assistance-list') return true
  if (method === 'read' || method === 'assistance-read' || method === 'accept' || method === 'reject') return typeof Reflect.get(value, 'id') === 'string'
  if (method === 'audit-read' || method === 'audit-resume' || method === 'audit-cancel' || method === 'run-read' || method === 'run-resume' || method === 'run-cancel') return typeof Reflect.get(value, 'runId') === 'string'
  if (method === 'audit-start') { const profile: unknown = Reflect.get(value, 'profile'); const maxCards: unknown = Reflect.get(value, 'maxCards'); return (profile === undefined || (typeof profile === 'string' && ['delivery-health', 'release', 'risk', 'spec', 'full'].includes(profile))) && (maxCards === undefined || typeof maxCards === 'number') }
  if (method === 'run-start') {
    if (['source', 'profile', 'maxCards'].some(key => Reflect.get(value, key) !== undefined)) return false
    return ['title', 'evidence', 'definitionJson'].every(key => Reflect.get(value, key) === undefined || typeof Reflect.get(value, key) === 'string') && (Reflect.get(value, 'questions') === undefined || (Array.isArray(Reflect.get(value, 'questions')) && (Reflect.get(value, 'questions') as unknown[]).every(question => typeof question === 'string')))
  }
  if (method === 'assess-card') return Reflect.get(value, 'title') === undefined && Reflect.get(value, 'body') === undefined && typeof Reflect.get(value, 'id') === 'string' && ASSESSMENT_KINDS.includes(Reflect.get(value, 'assessmentKind') as AssessmentKind)
  if (method !== 'assess') return false
  const kind: unknown = Reflect.get(value, 'assessmentKind')
  return Reflect.get(value, 'id') === undefined && typeof Reflect.get(value, 'title') === 'string' && typeof Reflect.get(value, 'body') === 'string' && (kind === undefined || ASSESSMENT_KINDS.includes(kind as AssessmentKind))
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
function trusted(req: IncomingMessage): string | undefined {
  const host = req.headers.host; if (host === undefined || req.headers['sec-fetch-site'] === 'cross-site') return undefined
  let authority: URL
  try { authority = new URL(`http://${host}`) } catch { return undefined }
  if (!loopback(authority.hostname)) return undefined
  const origin = req.headers.origin; if (origin === undefined) return host
  try { return new URL(origin).host === host ? host : undefined } catch { return undefined }
}
export function registerWeb(ctx: Context): () => void {
  return ctx.webServer.register({ kind: 'exact', path: '/devflow/jev/api', handler: async (req, res) => {
    const authority = trusted(req)
    if (authority === undefined) { respond(res, 403, { ok: false, error: 'forbidden' }); return }
    if (req.method !== 'POST') { respond(res, 405, { ok: false, error: 'post-required' }); return }
    let request: WebRequest
    try { request = await body(req) } catch { respond(res, 400, { ok: false, error: 'invalid-request' }); return }
    try {
      const { root, project, owner } = await scopeForSession(ctx, request.sessionId)
      switch (request.method) {
        case 'context': respond(res, 200, { ok: true, data: { projectName: basename(project), projectPath: project, genericRunsAvailable: ctx.get('jevRuns') !== undefined, assistanceAvailable: ctx.get('devflowAssistance') !== undefined, assistanceMode: ctx.get('devflowAssistance')?.config.mode } }); break
        case 'run-start': case 'run-list': case 'run-read': case 'run-resume': case 'run-cancel': {
          const runs = ctx.get('jevRuns'); if (runs === undefined) throw new Error('JEV_RUNS_UNAVAILABLE')
          const runRoot = join(project, '.jev')
          const data = request.method === 'run-start' ? await runs.run(project, { ...(request.title === undefined ? {} : { title: request.title }), ...(request.evidence === undefined ? {} : { evidence: request.evidence }), ...(request.questions === undefined ? {} : { questions: request.questions }), ...(request.definitionJson === undefined ? {} : { definitionJson: request.definitionJson }) }, requireOwner(owner))
            : request.method === 'run-list' ? await runs.durable.list(runRoot)
              : request.method === 'run-read' ? await runs.durable.inspect(runRoot, request.runId)
                : request.method === 'run-resume' ? await runs.control(project, { source: 'generic', id: request.runId, action: 'resume' }, requireOwner(owner))
                  : await runs.control(project, { source: 'generic', id: request.runId, action: 'cancel' }, requireOwner(owner))
          respond(res, 200, { ok: true, data }); break
        }
        case 'assistance-list': case 'assistance-read': {
          const assistance = ctx.get('devflowAssistance'); if (assistance === undefined) throw new Error('JEV_ASSISTANCE_UNAVAILABLE')
          const data = request.method === 'assistance-list' ? await assistance.list(project) : await assistance.read(project, request.id)
          respond(res, 200, { ok: true, data }); break
        }
        case 'list': respond(res, 200, { ok: true, data: await ctx.devflowJev.list(root) }); break
        case 'audit-list': respond(res, 200, { ok: true, data: await ctx.devflowJev.listAudits(root) }); break
        case 'audit-read': respond(res, 200, { ok: true, data: await ctx.devflowJev.inspectAudit(root, request.runId) }); break
        case 'audit-start': respond(res, 200, { ok: true, data: await ctx.devflowJev.startAudit(root, { ...(request.profile === undefined ? {} : { profile: request.profile }), ...(request.maxCards === undefined ? {} : { maxCards: request.maxCards }) }, requireOwner(owner)) }); break
        case 'audit-resume': case 'audit-cancel': respond(res, 200, { ok: true, data: await ctx.devflowJev.controlAudit(root, request.runId, request.method === 'audit-resume' ? 'resume' : 'cancel', requireOwner(owner)) }); break
        case 'assess-card': respond(res, 200, { ok: true, data: await ctx.devflowJev.assess(root, { target: 'card', id: request.id, assessmentKind: request.assessmentKind }) }); break
        case 'read': respond(res, 200, { ok: true, data: await ctx.devflowJev.read(root, request.id) }); break
        case 'accept': respond(res, 200, {
          ok: true,
          data: await ctx.devflowJev.decideJudgement(root, request.id, 'accept', { kind: 'human', name: `web:${authority}` }),
        }); break
        case 'reject': respond(res, 200, { ok: true, data: await ctx.devflowJev.decideJudgement(root, request.id, 'reject', { kind: 'human', name: 'web' }) }); break
        case 'assess': respond(res, 200, {
          ok: true,
          data: await ctx.devflowJev.assess(root, {
            target: 'request', title: request.title, body: request.body,
            ...(request.assessmentKind === undefined ? {} : { assessmentKind: request.assessmentKind }),
          }),
        }); break
      }
    } catch (error: unknown) { respond(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  } })
}
