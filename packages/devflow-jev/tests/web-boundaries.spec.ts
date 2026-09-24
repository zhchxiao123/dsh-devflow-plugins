/* oxlint-disable @stylistic/max-len */
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { JevRuntime, type JevRequest, type JevResponse } from '@zhchxiao123/dsh-jev'
import { afterEach, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'
import * as Runs from '@zhchxiao123/dsh-jev/runs-plugin'
import { emptyInbox } from '../../../tests/agent-double.ts'
class Provider extends JevRuntime {
  protected perform(_request: JevRequest): Promise<JevResponse> { return Promise.resolve({ answers: {
    codeSolvable: { type: 'noul', noul: 1 }, informationSufficient: { type: 'noul', noul: 1 }, value: { type: 'score', score: 4, probabilities: [0, 0, 0, 0, 1], confidence: 1 }, risk: { type: 'score', score: 0, probabilities: [1, 0, 0, 0, 0], confidence: 1 }, scopeClarity: { type: 'score', score: 4, probabilities: [0, 0, 0, 0, 1], confidence: 1 }, recommendedAction: { type: 'choice', choice: 'create', probabilities: { create: 1 }, confidence: 1 }, serviceClass: { type: 'choice', choice: 'standard', probabilities: { standard: 1 }, confidence: 1 },
  } }) }
}
let context: Context | undefined; let directory: string | undefined
afterEach(async () => { vi.restoreAllMocks(); await context?.fiber.dispose(); if (directory !== undefined) await rm(directory, { recursive: true, force: true }); context = undefined; directory = undefined })
async function boot() {
  directory = await mkdtemp(join(tmpdir(), 'jev-http-boundary-')); const root = join(directory, '.devflow'); const ctx = new Context(); context = ctx
  await ctx.plugin(SystemPrompt); await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }); await ctx.plugin(Sessions); await ctx.plugin(AgentRegistry); await ctx.plugin(Tools); await ctx.plugin(Jobs); await ctx.plugin(Provider); await ctx.plugin(FilesystemDevflowStore, { root }); await ctx.plugin(Runs); await ctx.plugin(Plugin, { policy: { autoCreate: false } })
  ctx.effect(() => ctx.jobs.attachController('web-boundary'))
  const session = ctx.sessions.create(SessionId('owner'), { meta: { cwd: directory } }); const scope = ctx.plugin(() => {})
  const agent: Agent = { id: session.id, session, ctx: scope.ctx, options: {}, inbox: emptyInbox(), status: 'idle', followup() {}, steer() {}, inject() {}, send() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(agent)
  return { ctx, root, agent }
}
function send(ctx: Context, value: unknown, options: { method?: string; raw?: string; headers?: Record<string, string>; noHost?: boolean } = {}): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: ctx.webServer.port, path: '/devflow/jev/api', method: options.method ?? 'POST', setHost: !(options.noHost || options.headers?.host !== undefined), headers: options.headers }, (res) => { let data = ''; res.on('data', (chunk) => { data += String(chunk) }); res.on('end', () => { let parsed: unknown = data; try { parsed = JSON.parse(data) } catch { /* HTTP parser failures can return plain text. */ } resolve({ status: res.statusCode ?? 0, data: parsed }) }) })
    req.on('error', reject); req.end(options.raw ?? JSON.stringify(value))
  })
}
it('enforces the HTTP trust, method and body boundaries', async () => {
  const { ctx } = await boot(); const value = { method: 'context', sessionId: 'owner' }
  for (const host of ['evil.example', '[', '']) expect((await send(ctx, value, { headers: { host } })).status).toBe(403)
  expect((await send(ctx, value, { noHost: true })).status).toBe(400)
  const legacy = await new Promise<string>((resolve, reject) => {
    const socket = connect(ctx.webServer.port, '127.0.0.1'); let data = ''
    socket.on('connect', () => { socket.end('POST /devflow/jev/api HTTP/1.0\r\nContent-Length: 0\r\n\r\n') })
    socket.on('data', (chunk) => { data += String(chunk) }); socket.on('end', () => { resolve(data) }); socket.on('error', reject)
  })
  expect(legacy).toContain('403 Forbidden')
  for (const origin of ['not-a-url', 'https://different.test']) expect((await send(ctx, value, { headers: { origin } })).status).toBe(403)
  for (const host of ['localhost', '[::1]']) expect((await send(ctx, value, { headers: { host, origin: `http://${host}` } })).data).toMatchObject({ ok: true })
  expect((await send(ctx, value, { method: 'GET' })).status).toBe(405)
  for (const raw of ['{', 'null', '7', '"text"', JSON.stringify({ method: 'context' }), JSON.stringify({ method: 'unknown', sessionId: 'owner' }), JSON.stringify({ method: 'context', sessionId: 'owner', padding: 'x'.repeat(65536) })]) expect((await send(ctx, value, { raw })).status).toBe(400)
  for (const invalid of [{ method: 'assess', title: 1, body: '' }, { method: 'assess', title: 'x', body: 'y', assessmentKind: 'bad' }, { method: 'audit-start', profile: 'bad' }, { method: 'audit-start', maxCards: '5' }, { method: 'run-start', title: 3 }, { method: 'run-start', questions: [3] }]) expect((await send(ctx, { sessionId: 'owner', ...invalid })).status).toBe(400)
})
it('reads persisted session context but requires a project and preserves non-Error failures', async () => {
  const { ctx } = await boot()
  class Persistence extends Service {
    constructor(child: Context) { super(child, 'sessionPersistence') }
    stat(id: string) { return Promise.resolve(id === 'saved' ? { header: { cwd: '/saved-project' } } : id === 'no-project' ? { header: {} } : undefined) }
  }
  await ctx.plugin(Persistence)
  expect((await send(ctx, { method: 'context', sessionId: 'saved' })).data).toMatchObject({ ok: true, data: { projectPath: '/saved-project' } })
  expect((await send(ctx, { method: 'context', sessionId: 'no-project' })).data).toEqual({ ok: false, error: 'PROJECT_CONTEXT_REQUIRED' })
  const failing = vi.spyOn(ctx.devflowJev, 'list').mockRejectedValueOnce('storage offline')
  expect((await send(ctx, { method: 'list', sessionId: 'owner' })).data).toEqual({ ok: false, error: 'storage offline' }); failing.mockRestore()
})
it('manages request proposals and audits through the scoped HTTP API', async () => {
  const { ctx, root, agent } = await boot(); const scope = { sessionId: 'owner' }
  expect((await send(ctx, { ...scope, method: 'list' })).data).toEqual({ ok: true, data: [] })
  for (const assessmentKind of [undefined, 'intake']) {
    const response = await send(ctx, { ...scope, method: 'assess', title: 'Request', body: 'Concrete evidence', assessmentKind })
    expect(response.data).toMatchObject({ ok: true, data: { decision: 'propose' } })
  }
  const records = await ctx.devflowJev.list(root); const [accepted, rejected] = records; if (!accepted || !rejected) throw new Error('missing proposals')
  expect((await send(ctx, { ...scope, method: 'read', id: accepted.id })).data).toMatchObject({ ok: true, data: { id: accepted.id } })
  expect((await send(ctx, { ...scope, method: 'accept', id: accepted.id })).data).toMatchObject({ ok: true, data: { status: 'created' } })
  expect((await send(ctx, { ...scope, method: 'reject', id: rejected.id })).data).toMatchObject({ ok: true, data: { status: 'rejected' } })
  await expect(ctx.devflowJev.reject(root, accepted.id)).rejects.toThrow('already created card')
  expect((await send(ctx, { ...scope, method: 'audit-start' })).data).toMatchObject({ ok: true, data: { manifest: { profile: 'delivery-health' } } })
  for (const job of ctx.jobs.list(agent)) await ctx.jobs.wait(job.id, 2000, agent)
  expect((await send(ctx, { ...scope, method: 'audit-list' })).data).toMatchObject({ ok: true, data: [{ state: { status: 'completed' } }] })
  const prepared = await ctx.devflowJev.prepareAudit({ root, profile: 'risk' })
  expect((await send(ctx, { ...scope, method: 'audit-resume', runId: prepared.manifest.id })).data).toMatchObject({ ok: true })
  for (const job of ctx.jobs.list(agent)) await ctx.jobs.wait(job.id, 2000, agent)
  const definition = { id: 'advanced', scope: { kind: 'workspace', id: 'x', title: 'x' }, template: { id: 'x', version: '1' }, createdAt: 't', checks: [] }
  expect((await send(ctx, { ...scope, method: 'run-start', definitionJson: JSON.stringify(definition) })).data).toMatchObject({ ok: true })
  for (const job of ctx.jobs.list(agent)) await ctx.jobs.wait(JobId(job.id), 2000, agent)
})
it('presents both assessment targets and rejects unowned tool calls', async () => {
  const { ctx, root, agent } = await boot()
  const call = (name: string, args: Record<string, unknown>, owning?: Agent) => ctx.tools.execute({ name, arguments: args, ...(owning === undefined ? {} : { agent: owning }), callId: ToolCallId('boundary'), signal: new AbortController().signal })
  expect((await call('devflow_assess', { target: 'request', title: 'x', body: 'y' })).isError).toBe(true)
  for (const args of [{ target: 'request', title: 'A' }, { target: 'card', id: 'B' }, { target: 'request' }]) expect(ctx.tools.get('devflow_assess')?.presentCall?.(args)?.title).toContain('Assess Devflow')
  expect(ctx.tools.get('devflow_decide_judgement')?.presentCall?.({ action: 'reject', id: 'test' })).toMatchObject({ kind: 'edit', title: 'reject judgement test' })
  const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Card', body: 'Evidence', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
  const result = await call('devflow_assess', { target: 'card', id: created.card.id, assessmentKind: 'planning' }, agent)
  expect(result.isError).toBeFalsy(); expect(result.content.some(block => block.type === 'text' && block.text.includes(created.card.id))).toBe(true)
})
