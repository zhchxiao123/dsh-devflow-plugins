import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { AssessmentKind } from './types.ts'
import { ASSESSMENT_KINDS } from './types.ts'
export type WebRequest = { method: 'list'; sessionId: string } | { method: 'read'; sessionId: string; id: string } | { method: 'accept' | 'reject'; sessionId: string; id: string } | { method: 'assess'; sessionId: string; title: string; body: string; assessmentKind?: AssessmentKind }
async function rootForSession(ctx: Context, raw: string): Promise<string> {
  const id = raw as SessionId; const live = ctx.get('sessions')?.get(id)
  const cwd = live?.header.cwd
  if (cwd !== undefined) return join(cwd, '.devflow')
  const snapshot = await ctx.get('sessionPersistence')?.stat(id)
  if (snapshot?.header.cwd === undefined) throw new Error(snapshot === undefined ? 'SESSION_NOT_FOUND' : 'PROJECT_CONTEXT_REQUIRED')
  return join(snapshot.header.cwd, '.devflow')
}
function valid(value: unknown): value is WebRequest {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'method') !== 'string' || typeof Reflect.get(value, 'sessionId') !== 'string') return false
  const method: unknown = Reflect.get(value, 'method')
  if (method === 'list') return true
  if (method === 'read' || method === 'accept' || method === 'reject') return typeof Reflect.get(value, 'id') === 'string'
  if (method !== 'assess') return false
  const kind: unknown = Reflect.get(value, 'assessmentKind')
  return typeof Reflect.get(value, 'title') === 'string' && typeof Reflect.get(value, 'body') === 'string' && (kind === undefined || ASSESSMENT_KINDS.includes(kind as AssessmentKind))
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
      const root = await rootForSession(ctx, request.sessionId)
      switch (request.method) {
        case 'list': respond(res, 200, { ok: true, data: await ctx.devflowJev.list(root) }); break
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
