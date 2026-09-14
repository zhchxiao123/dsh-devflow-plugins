/** The two optional capabilities compose without a live agent or Devflow cards. */
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SchedulerLocal from '@zhchxiao123/dsh-scheduler-local'
import GitHubSyncLocal from '@zhchxiao123/dsh-github-sync-local'
import { consumePage } from '@zhchxiao123/dsh-github-sync'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function boot(options: { holdIssues?: boolean; failIssues?: boolean } = {}): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'scheduled-github-sync-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/repos/acme/project/issues') {
      if (options.holdIssues) return
      if (options.failIssues) { response.writeHead(503); response.end('{}'); return }
      response.end(JSON.stringify([{
        id: 101, node_id: 'I_101', number: 7, title: 'A reproducible bug', body: 'Untrusted issue content',
        state: 'open', updated_at: '2026-09-14T00:00:00Z', html_url: 'https://github.com/acme/project/issues/7',
        comments: 0, labels: [], user: { login: 'reporter' },
      }]))
    } else if (url.pathname === '/repos/acme/project' ) {
      response.end(JSON.stringify({ id: 1, node_id: 'R_1', full_name: 'acme/project', has_discussions: false }))
    } else if (url.pathname.endsWith('/comments')) {
      response.end('[]')
    } else { response.writeHead(404); response.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  disposers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not listen')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@zhchxiao123/dsh-scheduler-local'",
    '  config:',
    `    databasePath: ${JSON.stringify(join(root, 'scheduler.sqlite'))}`,
    '    pollIntervalMs: 20',
    "- name: '@zhchxiao123/dsh-github-sync-local'",
    '  config:',
    `    databasePath: ${JSON.stringify(join(root, 'github.sqlite'))}`,
    `    apiUrl: http://127.0.0.1:${address.port}`,
    '    retryLimit: 0',
    '    pollIntervalMs: 20',
    '',
  ].join('\n'))
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@zhchxiao123/dsh-scheduler-local', SchedulerLocal],
    ['@zhchxiao123/dsh-github-sync-local', GitHubSyncLocal],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected plugin ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

it('delivers a scheduled sync and exposes the same run and durable changes to an independent consumer', async () => {
  const ctx = await boot()
  const subscription = await ctx.githubSync.createSubscription({ repository: 'acme/project', issues: true, discussions: false, actor: 'integration' })
  await ctx.githubSync.registerConsumer(subscription.id, 'summary', 'beginning')
  const plan = await ctx.scheduler.create({
    name: 'Repository issues', handler: 'github.sync', params: { subscriptionId: subscription.id },
    rule: { kind: 'interval', everyMs: 60_000 },
  }, 'integration')
  const trigger = await ctx.scheduler.trigger(plan.id, 'integration')
  await expect.poll(async () => {
    await ctx.scheduler.tick()
    return (await ctx.scheduler.history(plan.id)).find(item => item.id === trigger.id)?.state
  }, { timeout: 5_000 }).toBe('completed')
  const history = await ctx.scheduler.history(plan.id)
  const delivery = history.find(item => item.id === trigger.id)
  expect(delivery?.runId).toBeDefined()
  const runs = await ctx.githubSync.runs(subscription.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.id).toBe(delivery?.runId)
  expect(runs[0]?.status).toBe('succeeded')
  const changes = await ctx.githubSync.readChanges(subscription.id, 'summary', 100)
  expect(changes).toHaveLength(1)
  expect(changes[0]?.snapshot.title).toBe('A reproducible bug')
  const first = changes[0]
  if (first === undefined) throw new Error('Expected durable issue change')
  await ctx.githubSync.acknowledge(subscription.id, 'summary', first.sequence)
  expect(await ctx.githubSync.readChanges(subscription.id, 'summary', 100)).toEqual([])
})

it('reports downstream failure separately from successful durable delivery', async () => {
  const ctx = await boot({ failIssues: true })
  const subscription = await ctx.githubSync.createSubscription({ repository: 'acme/project', issues: true, discussions: false, actor: 'integration' })
  const plan = await ctx.scheduler.create({ name: 'Failing repository', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval', everyMs: 60_000 } }, 'integration')
  const trigger = await ctx.scheduler.trigger(plan.id, 'integration')
  await expect.poll(async () => {
    await ctx.scheduler.tick()
    return (await ctx.scheduler.history()).find(item => item.id === trigger.id)?.state
  }, { timeout: 5_000 }).toBe('failed')
  const delivery = (await ctx.scheduler.history()).find(item => item.id === trigger.id)
  expect(delivery?.acceptedAt).toBeDefined()
  expect(delivery?.attempts).toBe(1)
  expect(await ctx.githubSync.runs(subscription.id)).toHaveLength(1)
})

it('cancels an accepted synchronization through its scheduled trigger', async () => {
  const ctx = await boot({ holdIssues: true })
  const subscription = await ctx.githubSync.createSubscription({ repository: 'acme/project', issues: true, discussions: false, actor: 'integration' })
  const plan = await ctx.scheduler.create({ name: 'Slow repository', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval', everyMs: 60_000 } }, 'integration')
  const trigger = await ctx.scheduler.trigger(plan.id, 'integration')
  await expect.poll(async () => {
    await ctx.scheduler.tick()
    return (await ctx.scheduler.history()).find(item => item.id === trigger.id)?.state
  }).toBe('accepted')
  await ctx.scheduler.cancel(trigger.id, 'integration')
  await expect.poll(async () => {
    await ctx.scheduler.tick()
    return (await ctx.scheduler.history()).find(item => item.id === trigger.id)?.state
  }).toBe('cancelled')
  expect((await ctx.githubSync.runs(subscription.id))[0]?.status).toBe('cancelled')
})

it('rejects extra schedule parameters before a GitHub task can be accepted', async () => {
  const ctx = await boot()
  await expect(ctx.scheduler.create({ name: 'Invalid request', handler: 'github.sync', params: { subscriptionId: 'unknown', command: 'execute this' }, rule: { kind: 'interval', everyMs: 60_000 } }, 'integration')).rejects.toThrow('subscriptionId')
  expect(await ctx.githubSync.runs()).toEqual([])
})

it('retries the example consumer after an unconfirmed side effect without losing its change', async () => {
  const ctx = await boot()
  const subscription = await ctx.githubSync.createSubscription({ repository: 'acme/project', issues: true, discussions: false, actor: 'integration' })
  const receipt = await ctx.githubSync.sync(subscription.id, { actor: 'integration' })
  await expect.poll(async () => (await ctx.githubSync.run(receipt.runId))?.status).toBe('succeeded')
  const applied = new Set<string>()
  await expect(consumePage(ctx.githubSync, subscription.id, 'example', 100, async change => {
    applied.add(change.id)
    throw new Error('Consumer interrupted before acknowledgement')
  })).rejects.toThrow('interrupted')
  expect((await ctx.githubSync.readChanges(subscription.id, 'example', 100)).length).toBe(1)
  expect(await consumePage(ctx.githubSync, subscription.id, 'example', 100, async change => { applied.add(change.id) })).toBe(1)
  expect(applied.size).toBe(1)
  expect(await consumePage(ctx.githubSync, subscription.id, 'example', 100, async () => { throw new Error('No change should be delivered') })).toBe(0)
})

it('keeps an accepted delivery unresolved when its downstream durable run is externally lost', async () => {
  const ctx = await boot({ holdIssues: true })
  const subscription = await ctx.githubSync.createSubscription({ repository: 'acme/project', issues: true, discussions: false, actor: 'integration' })
  const plan = await ctx.scheduler.create({ name: 'Lost downstream receipt', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval', everyMs: 60_000 } }, 'integration')
  const trigger = await ctx.scheduler.trigger(plan.id, 'integration')
  await expect.poll(async () => {
    await ctx.scheduler.tick()
    return (await ctx.scheduler.history()).find(item => item.id === trigger.id)?.state
  }).toBe('accepted')
  const delivery = (await ctx.scheduler.history()).find(item => item.id === trigger.id)
  if (delivery?.runId === undefined) throw new Error('No durable receipt')
  // Fault injection at the durable boundary; assertions still use public services.
  const database = new DatabaseSync(fileURLToPath(new URL('github.sqlite', ctx.baseUrl)))
  try { database.prepare('DELETE FROM runs WHERE id=?').run(delivery.runId) } finally { database.close() }
  await expect.poll(async () => {
    await ctx.scheduler.tick()
    return (await ctx.scheduler.history()).find(item => item.id === trigger.id)?.error
  }).toBe('STATUS_UNAVAILABLE')
  expect((await ctx.scheduler.history()).find(item => item.id === trigger.id)?.state).toBe('accepted')
})
