import { registerValidationHandler } from '../../../tests/scheduler-validation-handler.ts'
/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Scheduler from '@zhchxiao123/dsh-scheduler-local'
import GitHub from '@zhchxiao123/dsh-github-sync-local'
import { afterEach, expect, it } from 'vitest'
import { installProjectHost } from '../../../tests/automation-project-host.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Automation from '../src/index.ts'
import { automationRequest } from '../src/client.ts'
import type { AutomationRequest } from '../src/types.ts'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0 })
async function boot(capabilities: 'both' | 'scheduler' | 'github' | 'none' = 'both') {
  const root = await mkdtemp(join(tmpdir(), 'automation-http-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let fail = true
  const external = createServer((_req, res) => { res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' }); res.end('[]') })
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => external.close(() => { resolve() })))
  const address = external.address()
  if (!address || typeof address === 'string') throw new Error('fixture not listening')
  const entries = [
    ...capabilities === 'both' || capabilities === 'scheduler' ? [{ name: 'scheduler', config: { databasePath: join(root, 'scheduler.db'), pollIntervalMs: 60000 } }] : [],
    ...capabilities === 'both' || capabilities === 'github' ? [{ name: 'github', config: { databasePath: join(root, 'github.db'), apiUrl: `http://127.0.0.1:${address.port}`, pollIntervalMs: 10, retryLimit: 0 } }] : [],
    { name: 'server', config: { host: '127.0.0.1', port: 0 } }, { name: 'automation', config: { trustedHosts: ['localhost'] } },
  ]
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify(entries))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['scheduler', Scheduler], ['github', GitHub], ['server', WebServer], ['automation', Automation]])
  ctx.loader.internal = { version: 'v2', async import(name: string) { return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await installProjectHost(ctx, root)
  const project = await ctx.workspaceRegistry.create(root, 'Fixture project')
  ctx.sessions.create(SessionId('fixture-session'), { meta: { cwd: root } })
  const port = ctx.webServer.port
  const call = (body: unknown, method = 'POST', headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/automation/api', method, headers }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += String(chunk) }); res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    }); req.on('error', reject); req.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  // Adapt only the browser's relative URL. The client decoder still consumes the real HTTP response.
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = (input, init) => fetchOriginal(typeof input === 'string' && input === '/automation/api' ? `http://127.0.0.1:${port}${input}` : input, init)
  cleanups.push(async () => { globalThis.fetch = fetchOriginal })
  return { ctx, call, project, root, pass: () => { fail = false } }
}
it('projects durable subscriptions, plans and original run recovery through real HTTP and Loader', async () => {
  const { ctx, pass } = await boot()
  const input = { repository: 'owner/repo', issues: true, discussions: false }
  const sub = await automationRequest({ sessionId: 'fixture-session', method: 'subscription.save', input })
  expect(sub.actor).toMatch(/^web:127.0.0.1:/)
  await automationRequest({ sessionId: 'fixture-session', method: 'subscription.save', id: sub.id, input: { ...input, credentialRef: 'env:AUTOMATION_UNUSED' } })
  // Clear credential through the service; the fixture must not require a real secret.
  process.env.AUTOMATION_UNUSED = 'fixture-token'
  cleanups.push(async () => { delete process.env.AUTOMATION_UNUSED })
  await automationRequest({ sessionId: 'fixture-session', method: 'subscription.action', id: sub.id, action: 'pause' })
  await automationRequest({ sessionId: 'fixture-session', method: 'subscription.action', id: sub.id, action: 'resume' })
  const planInput = { name: 'Scan', handler: 'github.sync', params: { subscriptionId: sub.id }, rule: { kind: 'interval' as const, everyMs: 3600000 } }
  const plan = await automationRequest({ sessionId: 'fixture-session', method: 'plan.save', input: planInput })
  await automationRequest({ sessionId: 'fixture-session', method: 'plan.save', id: plan.id, input: { ...planInput, name: 'Scan updated' } })
  await automationRequest({ sessionId: 'fixture-session', method: 'plan.action', id: plan.id, action: 'pause' })
  await automationRequest({ sessionId: 'fixture-session', method: 'plan.action', id: plan.id, action: 'resume' })
  const trigger = await automationRequest({ sessionId: 'fixture-session', method: 'plan.action', id: plan.id, action: 'trigger' })
  expect(trigger).toMatchObject({ state: 'pending' })
  await automationRequest({ sessionId: 'fixture-session', method: 'plan.action', id: trigger!.id, action: 'cancel' })
  const receipt = await automationRequest({ sessionId: 'fixture-session', method: 'subscription.action', id: sub.id, action: 'sync' })
  if (!('runId' in receipt)) throw new Error('expected receipt')
  await expect.poll(async () => (await ctx.githubSync.run(receipt.runId))?.status).toBe('failed')
  pass()
  await automationRequest({ sessionId: 'fixture-session', method: 'run.action', id: receipt.runId, action: 'resume' })
  await expect.poll(async () => (await ctx.githubSync.run(receipt.runId))?.status).toBe('succeeded')
  await automationRequest({ sessionId: 'fixture-session', method: 'run.action', id: receipt.runId, action: 'cancel' })
  expect(await automationRequest({ sessionId: 'fixture-session', method: 'content', subscriptionId: sub.id })).toEqual([])
  expect(await automationRequest({ sessionId: 'fixture-session', method: 'capacity.set', bytes: 20000000 })).toMatchObject({ capacityBytes: 20000000, capacityChangedBy: sub.actor })
  await automationRequest({ sessionId: 'fixture-session', method: 'plan.action', id: plan.id, action: 'remove' })
  const overview = await automationRequest({ sessionId: 'fixture-session', method: 'overview' }, new AbortController().signal)
  expect(overview).toMatchObject({ schedulerAvailable: true, githubAvailable: true, subscriptions: [{ id: sub.id }], runs: [{ id: receipt.runId, status: 'succeeded' }] })
  expect(overview.triggers[0]?.state).toBe('cancelled')
})
it.each(['none', 'scheduler', 'github'] as const)('keeps missing capability explicit: %s', async (capabilities) => {
  await boot(capabilities)
  const overview = await automationRequest({ sessionId: 'fixture-session', method: 'overview' })
  expect(overview.schedulerAvailable).toBe(capabilities === 'scheduler')
  expect(overview.githubAvailable).toBe(capabilities === 'github')
  const missing: AutomationRequest[] = capabilities === 'scheduler' ? [
    { sessionId: 'fixture-session', method: 'content', subscriptionId: 'x' }, { sessionId: 'fixture-session', method: 'subscription.save', input: { repository: 'a/b', issues: true, discussions: false } }, { sessionId: 'fixture-session', method: 'subscription.action', id: 'x', action: 'sync' }, { sessionId: 'fixture-session', method: 'run.action', id: 'x', action: 'cancel' }, { sessionId: 'fixture-session', method: 'capacity.set', bytes: 1 },
  ] : [{ sessionId: 'fixture-session', method: 'plan.save', input: { name: 'x', handler: 'x', params: {}, rule: { kind: 'interval', everyMs: 1000 } } }, { sessionId: 'fixture-session', method: 'plan.action', id: 'x', action: 'pause' }]
  for (const request of missing) await expect(automationRequest(request)).rejects.toThrow('unavailable')
})
it('rejects forged identities, hostile browser origins, malformed and oversized input; removes the route', async () => {
  const { ctx, call } = await boot()
  expect((await call({}, 'GET')).status).toBe(405)
  expect((await call({}, 'POST', { origin: 'https://evil.example' })).status).toBe(403)
  expect((await call({}, 'POST', { host: 'evil.example' })).status).toBe(403)
  for (const body of ['{', 'x'.repeat(70000), { sessionId: 'fixture-session', method: 'overview', actor: 'admin' }, { sessionId: 'fixture-session', method: 'content', subscriptionId: '' }, { sessionId: 'fixture-session', method: 'capacity.set', bytes: -1 }, { sessionId: 'fixture-session', method: 'plan.save', input: {} }, { sessionId: 'fixture-session', method: 'subscription.save', input: { repository: 'a/b', issues: true, discussions: false, credentialRef: 'ghp_secret' } }]) expect((await call(body)).status).toBe(400)
  const input = { repository: 'a/b', issues: true, discussions: false }
  const sub = await automationRequest({ sessionId: 'fixture-session', method: 'subscription.save', input })
  for (const id of [sub.id, 'missing']) await expect(automationRequest({ sessionId: 'fixture-session', method: 'subscription.save', id, input: { ...input, repository: 'x/y' } })).rejects.toThrow('subscription-repository-mismatch')
  const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'automation')
  expect(entry).toBeDefined()
  await entry!.fiber!.dispose()
  expect((await call({ sessionId: 'fixture-session', method: 'overview' })).status).toBe(404)
})

it('preserves service-created plan strings without imposing browser input limits on responses', async () => {
  const { ctx, project } = await boot('scheduler')
  const handler = '  exact handler  '
  const name = `  ${'long name '.repeat(40)}  `
  const actor = `  ${'actor'.repeat(70)}  `
  ctx.scheduler.registerHandler(handler, {
    validate() {},
    async accept() { return { runId: 'unused' } },
    async status() { return { state: 'completed' } },
    async cancel() {},
  })
  const plan = await ctx.scheduler.create({
    projectId: project.id, name, handler, params: { text: '  original payload  ' },
    rule: { kind: 'cron', expression: '  0 * * * *  ', timezone: 'UTC' },
  }, actor)
  const overview = await automationRequest({ sessionId: 'fixture-session', method: 'overview' })
  expect(overview.plans).toEqual([plan])
  expect(overview.plans[0]).toMatchObject({ name, handler, createdBy: actor, updatedBy: actor })
  const saved = await automationRequest({ sessionId: 'fixture-session', method: 'plan.save', input: {
    name: '  browser plan  ', handler, params: { text: '  original payload  ' },
    rule: { kind: 'interval', everyMs: 3600000 },
  } })
  expect(saved).toMatchObject({ name: '  browser plan  ', handler, params: { text: '  original payload  ' } })
  expect((await ctx.scheduler.list()).find(item => item.id === saved.id)).toEqual(saved)
})
it('separates unassigned data and claims into the session project only on explicit request', async () => {
  const { root, project, ctx } = await boot()
  registerValidationHandler(ctx.scheduler, 'custom')
  for (const [filename, table, value] of [
    ['scheduler.db', 'plans', { id: 'legacy-plan', name: 'Old plan', handler: 'custom', params: {}, rule: { kind: 'interval', everyMs: 3600000 }, enabled: false, deleted: false, nextAt: 0, createdBy: 'legacy', updatedBy: 'legacy', projectId: null }],
    ['github.db', 'subscriptions', { id: 'legacy-sub', repository: 'a/b', issues: true, discussions: false, actor: 'legacy', paused: true, revision: 1, projectId: null }],
  ] as const) {
    const db = new DatabaseSync(join(root, filename))
    db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run(value.id, JSON.stringify(value)); db.close()
  }
  const unassigned = await automationRequest({ sessionId: 'fixture-session', method: 'unassigned' })
  expect(unassigned.plans).toHaveLength(1); expect(unassigned.subscriptions).toHaveLength(1)
  expect((await automationRequest({ sessionId: 'fixture-session', method: 'overview' })).plans).toEqual([])
  for (const [kind, id] of [['plan', 'legacy-plan'], ['subscription', 'legacy-sub']] as const) {
    expect(await automationRequest({ sessionId: 'fixture-session', method: 'claim', kind, id })).toMatchObject({ projectId: project.id })
  }
  expect(await automationRequest({ sessionId: 'fixture-session', method: 'unassigned' })).toEqual({ plans: [], subscriptions: [] })
})
it('lists no unassigned records and rejects claims when their capability is absent', async () => {
  await boot('none')
  expect(await automationRequest({ sessionId: 'fixture-session', method: 'unassigned' })).toEqual({ plans: [], subscriptions: [] })
  for (const kind of ['plan', 'subscription'] as const) await expect(automationRequest({ sessionId: 'fixture-session', method: 'claim', kind, id: 'x' })).rejects.toThrow('unavailable')
})
