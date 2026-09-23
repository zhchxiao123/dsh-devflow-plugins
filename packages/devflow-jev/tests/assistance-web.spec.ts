import { request } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import type { AssistanceRecord } from '../src/assistance-types.ts'
import { assistanceConfig } from '../src/assistance-config.ts'
import { registerWeb } from '../src/web.ts'

const record: AssistanceRecord = {
  id: 'assist-record', workspace: '/project-a', sessionId: 'owner', turn: 1,
  event: 'completion', mode: 'observe', evidenceDigest: 'digest', policyVersion: '1',
  action: 'add-verification', reason: 'Missing restart test', evidenceRefs: ['src/store.ts'], gaps: ['No restart evidence'],
  confidence: 0.8, status: 'observed', outcome: 'unknown', elapsedMs: 42,
  createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
}
class AssistanceFixture extends Service {
  readonly config = assistanceConfig()
  constructor(ctx: Context) { super(ctx, 'devflowAssistance') }
  list(project: string): Promise<AssistanceRecord[]> { return Promise.resolve(project === record.workspace ? [record] : []) }
  async read(project: string, id: string): Promise<AssistanceRecord> {
    const value = (await this.list(project)).find(item => item.id === id)
    if (value === undefined) throw new Error('record-not-found')
    return value
  }
}
let context: Context | undefined
// Each test server is ephemeral; no user project or running web profile is used.
afterEach(async () => { await context?.fiber.dispose(); context = undefined })
async function boot() {
  const ctx = new Context(); context = ctx
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }); await ctx.plugin(Sessions)
  ctx.sessions.create(SessionId('owner'), { meta: { cwd: '/project-a' } })
  ctx.sessions.create(SessionId('foreign'), { meta: { cwd: '/project-b' } })
  ctx.effect(() => registerWeb(ctx))
  return ctx
}
function post(port: number, value: unknown, headers: Record<string, string> = {}): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(value)
    const req = request({ host: '127.0.0.1', port, path: '/devflow/jev/api', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += String(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, value: JSON.parse(body) as unknown }) })
    })
    req.on('error', reject); req.end(payload)
  })
}
it('uses the session project for list/read and rejects malformed or foreign-origin requests', async () => {
  const ctx = await boot(); await ctx.plugin(AssistanceFixture)
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: 'owner', project: '/project-b', root: '/project-b' })).value).toEqual({ ok: true, data: [record] })
  expect((await post(ctx.webServer.port, { method: 'assistance-read', sessionId: 'owner', id: record.id })).value).toEqual({ ok: true, data: record })
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: 'foreign', project: '/project-a' })).value).toEqual({ ok: true, data: [] })
  expect((await post(ctx.webServer.port, { method: 'assistance-read', sessionId: 'foreign', id: record.id, root: '/project-a' })).value).toEqual({ ok: false, error: 'record-not-found' })
  expect((await post(ctx.webServer.port, { method: 'assistance-read', sessionId: 'owner' })).status).toBe(400)
  expect((await post(ctx.webServer.port, { method: 'assistance-read', sessionId: 'owner', id: 42 })).status).toBe(400)
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: 'missing' })).value).toEqual({ ok: false, error: 'SESSION_NOT_FOUND' })
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: 'owner' }, { origin: 'https://foreign.example' })).status).toBe(403)
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: 'owner' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
})
it('reports optional service absence and sees it again after remount', async () => {
  const ctx = await boot()
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: 'owner' })).value).toEqual({ ok: false, error: 'JEV_ASSISTANCE_UNAVAILABLE' })
  expect((await post(ctx.webServer.port, { method: 'context', sessionId: 'owner' })).value).toMatchObject({ data: { assistanceAvailable: false } })
  const fiber = ctx.plugin(AssistanceFixture); await fiber
  expect((await post(ctx.webServer.port, { method: 'context', sessionId: 'owner' })).value).toMatchObject({ data: { assistanceAvailable: true, assistanceMode: 'observe' } })
  await fiber.dispose()
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: 'owner' })).value).toEqual({ ok: false, error: 'JEV_ASSISTANCE_UNAVAILABLE' })
  await ctx.plugin(AssistanceFixture)
  expect((await post(ctx.webServer.port, { method: 'assistance-read', sessionId: 'owner', id: record.id })).value).toEqual({ ok: true, data: record })
})
