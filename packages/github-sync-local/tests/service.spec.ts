import { consumePage } from '../../github-sync/src/example.ts'
import LocalScheduler from '../../scheduler-local/src/index.ts'
/// <reference types="node" />
import { createServer } from 'node:http'
import process from 'node:process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalGitHubSync, { Config } from '../src/index.ts'
import type { Config as Configuration } from '../src/index.ts'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})
async function boot(
  respond: (path: URL) => { status?: number; body: unknown },
  overrides: Partial<Configuration> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const server = createServer((request, response) => {
    const result = respond(new URL(request.url ?? '/', 'http://localhost'))
    response.writeHead(result.status ?? 200, {
      'Content-Type': 'application/json',
    })
    response.end(JSON.stringify(result.body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        }),
      ),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const config = Config({
    databasePath: join(root, 'state.sqlite'),
    apiUrl: `http://127.0.0.1:${address.port}`,
    pollIntervalMs: 10,
    retryDelayMs: 1,
    retryLimit: 0,
    ...overrides,
  })
  await ctx.plugin(LocalGitHubSync, config)
  const service = ctx.githubSync
  const subscription = await service.createSubscription({
    projectId: 'test-project', repository: 'owner/repo',
    issues: true,
    discussions: false,
    actor: 'test',
  })
  async function sync() {
    const receipt = await service.sync(subscription.id, { actor: 'test' })
    await expect
      .poll(async () => (await service.run(receipt.runId))?.status)
      .not.toMatch(/queued|running|waiting/u)
    return (await service.run(receipt.runId))!
  }
  return { service, subscription, sync, config, ctx }
}
const issue = (body = 'first') => ({
  id: 1,
  node_id: 'I1',
  number: 1,
  body,
  title: 'bug',
  state: 'open',
  html_url: 'https://github.com/owner/repo/issues/1',
  updated_at: '2026-09-14T00:00:00Z',
})
it('persists version-specific changes and independent contiguous consumer acknowledgements', async () => {
  let body = 'first'
  const { service, subscription, sync } = await boot(url => ({
    body: url.pathname.endsWith('/issues')
      ? [issue(body), { pull_request: {} }]
      : [],
  }))
  expect((await sync()).status).toBe('succeeded')
  await service.registerConsumer(subscription.id, 'one', 'beginning')
  await service.registerConsumer(subscription.id, 'two', 'beginning')
  const original = await service.readChanges(subscription.id, 'one', 10)
  expect(original).toHaveLength(1)
  await expect(
    service.acknowledge(subscription.id, 'two', original[0].sequence),
  ).rejects.toThrow('delivered')
  await service.acknowledge(subscription.id, 'one', original[0].sequence)
  expect(await service.readChanges(subscription.id, 'one', 10)).toEqual([])
  expect(
    (await service.readChanges(subscription.id, 'two', 10))[0]?.snapshot.body,
  ).toBe('first')
  expect((await sync()).status).toBe('succeeded')
  expect(await service.readChanges(subscription.id, 'one', 10)).toEqual([])
  body = 'edited'
  await sync()
  const updated = await service.readChanges(subscription.id, 'one', 10)
  expect(updated[0]?.snapshot.version).toBe(2)
  await service.replay(subscription.id, 'one', 'beginning')
  const history = await service.readChanges(subscription.id, 'one', 10)
  expect(history.map(change => change.snapshot.body)).toEqual([
    'first',
    'edited',
  ])
  await expect(
    service.acknowledge(subscription.id, 'one', history[1].sequence),
  ).rejects.toThrow('next')
})
it('idempotently accepts triggers, pauses new work, and preserves existing receipt', async () => {
  const { service, subscription } = await boot(() => ({ body: [] }))
  const receipt = await service.sync(subscription.id, {
    actor: 'test',
    triggerId: 'stable',
  })
  await service.updateSubscription(subscription.id, {
    paused: true,
    actor: 'test',
  })
  expect(
    await service.sync(subscription.id, { actor: 'test', triggerId: 'stable' }),
  ).toEqual(receipt)
  await expect(
    service.sync(subscription.id, { actor: 'test' }),
  ).rejects.toThrow('paused')
  await service.cancel(receipt.runId, 'test')
  expect((await service.run(receipt.runId))?.status).toBe('cancelled')
})
it('preserves snapshots on authorization failure and records deletion only after complete reconciliation', async () => {
  let status = 200
  let rows: unknown[] = [issue()]
  const { service, subscription, sync } = await boot(url => ({
    status,
    body: url.pathname.endsWith('/issues') ? rows : [],
  }))
  await sync()
  status = 403
  expect((await sync()).status).toBe('failed')
  expect((await service.snapshots(subscription.id))[0]?.deleted).toBe(false)
  status = 200
  rows = []
  const receipt = await service.sync(subscription.id, {
    actor: 'test',
    reconcile: true,
  })
  await expect
    .poll(async () => (await service.run(receipt.runId))?.status)
    .toBe('succeeded')
  expect((await service.snapshots(subscription.id))[0]?.deleted).toBe(true)
})
it('capacity failure rolls back content and remains readable after raising the durable limit', async () => {
  const { service, subscription, sync } = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue('x'.repeat(10000))] : [],
  }))
  await service.setCapacity(2000, 'test')
  expect((await sync()).status).toBe('failed')
  expect(await service.snapshots(subscription.id)).toEqual([])
  await service.setCapacity(1000000, 'test')
  expect((await sync()).status).toBe('succeeded')
  expect(await service.snapshots(subscription.id)).toHaveLength(1)
})
it('resumes an interrupted paginated run under a new instance without refetching committed pages', async () => {
  let firstPageRequests = 0
  let blocked = true
  const fixture = await boot(
    (url) => {
      if (url.pathname.endsWith('/issues')) {
        if (url.searchParams.get('page') === '1') {
          firstPageRequests++
          return { body: [issue()] }
        }
        return { body: [] }
      }
      if (blocked) return { status: 429, body: {} }
      return { body: [] }
    },
    {
      pageSize: 1,
      retryLimit: 10,
      retryDelayMs: 1000,
      leaseMs: 100,
      pollIntervalMs: 10,
    },
  )
  const receipt = await fixture.service.sync(fixture.subscription.id, {
    actor: 'test',
    triggerId: 'recover',
  })
  await expect
    .poll(async () => (await fixture.service.run(receipt.runId))?.status)
    .toBe('waiting')
  await fixture.ctx.fiber.dispose()
  blocked = false
  await new Promise(resolve => setTimeout(resolve, 110))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalGitHubSync, fixture.config)
  await expect
    .poll(async () => (await ctx.githubSync.run(receipt.runId))?.status)
    .toBe('succeeded')
  expect(firstPageRequests).toBe(1)
  expect(await ctx.githubSync.snapshots(fixture.subscription.id)).toHaveLength(
    1,
  )
  expect(
    await ctx.githubSync.sync(fixture.subscription.id, {
      actor: 'test',
      triggerId: 'recover',
    }),
  ).toEqual(receipt)
})
it('serializes the same subscription across instances and fences cancellation', async () => {
  const fixture = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue()] : [],
  }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalGitHubSync, fixture.config)
  const [a, b] = await Promise.all([
    fixture.service.sync(fixture.subscription.id, {
      actor: 'a',
      triggerId: 'one',
    }),
    ctx.githubSync.sync(fixture.subscription.id, {
      actor: 'b',
      triggerId: 'one',
    }),
  ])
  expect(a).toEqual(b)
  await expect
    .poll(async () => (await ctx.githubSync.run(a.runId))?.status)
    .toBe('succeeded')
  expect(await fixture.service.runs()).toHaveLength(1)
  await fixture.service.registerConsumer(
    fixture.subscription.id,
    'test',
    'beginning',
  )
  expect(
    await fixture.service.readChanges(fixture.subscription.id, 'test', 100),
  ).toHaveLength(1)
})
it('rejects malformed inputs, unsupported scope changes and consumer gaps', async () => {
  const { service, subscription, sync } = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue()] : [],
  }))
  await expect(
    service.createSubscription({
      projectId: 'test-project', repository: 'bad',
      issues: true,
      discussions: false,
      actor: 'test',
    }),
  ).rejects.toThrow('owner/repository')
  await expect(
    service.createSubscription({
      projectId: 'test-project', repository: 'a/b',
      credentialRef: 'secret',
      issues: true,
      discussions: false,
      actor: 'test',
    }),
  ).rejects.toThrow('reference')
  await expect(
    service.updateSubscription(subscription.id, {
      projectId: 'test-project', repository: 'other/repo',
      actor: 'test',
    }),
  ).rejects.toThrow('new subscription')
  await sync()
  await expect(
    service.readChanges(subscription.id, 'missing', 1),
  ).rejects.toThrow('consumer')
  await service.registerConsumer(subscription.id, 'now', 'now')
  expect(await service.readChanges(subscription.id, 'now', 100)).toEqual([])
  await expect(service.readChanges(subscription.id, 'now', 0)).rejects.toThrow(
    'limit',
  )
  await expect(service.setCapacity(-1, 'test')).rejects.toThrow('capacity')
})
it('notifies after commit, tolerates listener failures and releases subscriptions', async () => {
  const { service, subscription, sync } = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue()] : [],
  }))
  let notifications = 0
  const stop = service.watch(subscription.id, () => {
    notifications++
  })
  const stopBroken = service.watch(subscription.id, () => {
    throw new Error('consumer unavailable')
  })
  expect((await sync()).status).toBe('succeeded')
  expect(notifications).toBeGreaterThan(0)
  stop()
  stopBroken()
  const before = notifications
  await sync()
  expect(notifications).toBe(before)
})
it('marks page-budget exhaustion and malformed comments partial without advancing the baseline', async () => {
  const fixture = await boot(
    url => ({ body: url.pathname.endsWith('/issues') ? [issue()] : [] }),
    { maxPages: 1 },
  )
  const result = await fixture.sync()
  expect(result.status).toBe('partial')
  expect(result.error).toContain('budget')
  expect(
    (await fixture.service.subscriptions())[0]?.lastSuccessAt,
  ).toBeUndefined()
  const malformed = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue()] : { invalid: true },
  }))
  expect((await malformed.sync()).status).toBe('partial')
  expect(
    await malformed.service.snapshots(malformed.subscription.id),
  ).toHaveLength(1)
})
it('keeps receipt namespaces exclusive and rejects missing credentials without exposing their value', async () => {
  const fixture = await boot(() => ({ body: [] }))
  const another = await fixture.service.createSubscription({
    projectId: 'test-project', repository: 'other/repo',
    issues: true,
    discussions: false,
    actor: 'test',
    credentialRef: 'env:GH_SYNC_MISSING_TEST_TOKEN',
  })
  const receipt = await fixture.service.sync(another.id, {
    actor: 'test',
    triggerId: 'exclusive',
  })
  await expect(
    fixture.service.sync(fixture.subscription.id, {
      actor: 'test',
      triggerId: 'exclusive',
    }),
  ).rejects.toThrow('another subscription')
  await expect
    .poll(async () => (await fixture.service.run(receipt.runId))?.status)
    .toBe('failed')
  expect((await fixture.service.run(receipt.runId))?.error).toBe(
    'Credential reference unavailable',
  )
  await expect(fixture.service.cancel('missing', 'test')).rejects.toThrow(
    'Unknown run',
  )
  await expect(fixture.service.snapshots('missing')).rejects.toThrow(
    'Unknown subscription',
  )
})
it('shares persisted capacity and consumer positions across restart', async () => {
  const fixture = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue()] : [],
  }))
  await fixture.sync()
  await fixture.service.registerConsumer(
    fixture.subscription.id,
    'reader',
    'beginning',
  )
  const changes = await fixture.service.readChanges(
    fixture.subscription.id,
    'reader',
    1,
  )
  await fixture.service.acknowledge(
    fixture.subscription.id,
    'reader',
    changes[0].sequence,
  )
  await fixture.service.setCapacity(123456, 'test')
  await fixture.ctx.fiber.dispose()
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalGitHubSync, fixture.config)
  expect((await ctx.githubSync.storage()).capacityBytes).toBe(123456)
  expect(
    await ctx.githubSync.readChanges(fixture.subscription.id, 'reader', 100),
  ).toEqual([])
  await ctx.githubSync.replay(fixture.subscription.id, 'reader', 'now')
  expect(
    await ctx.githubSync.readChanges(fixture.subscription.id, 'reader', 100),
  ).toEqual([])
})
it('resets compatible scope baselines and rejects malformed subscriptions or replay parameters', async () => {
  const fixture = await boot(() => ({ body: [] }))
  await fixture.sync()
  const updated = await fixture.service.updateSubscription(
    fixture.subscription.id,
    { issues: true, discussions: true, actor: 'test' },
  )
  expect(updated.lastSuccessAt).toBeUndefined()
  expect(updated.lastReconcileAt).toBeUndefined()
  await expect(
    fixture.service.createSubscription({
      projectId: 'test-project', repository: 'a/b',
      issues: false,
      discussions: false,
      actor: 'test',
    }),
  ).rejects.toThrow('Select')
  await expect(
    fixture.service.createSubscription({
      projectId: 'test-project', repository: 'a/b',
      issues: true,
      discussions: false,
      actor: '',
    }),
  ).rejects.toThrow('non-empty')
  await fixture.service.setCapacity(1, 'test')
  expect((await fixture.service.storage()).blocked).toBe(true)
  await expect(
    fixture.service.sync(fixture.subscription.id, { actor: 'test' }),
  ).rejects.toThrow('capacity')
})
it('refuses scope changes during an accepted run and cancels a remote wait from another instance', async () => {
  const fixture = await boot(() => ({ status: 429, body: {} }), {
    retryLimit: 2,
    retryDelayMs: 1000,
    pollIntervalMs: 10,
  })
  const receipt = await fixture.service.sync(fixture.subscription.id, {
    actor: 'test',
  })
  await expect
    .poll(async () => (await fixture.service.run(receipt.runId))?.status)
    .toBe('waiting')
  await expect(
    fixture.service.updateSubscription(fixture.subscription.id, {
      discussions: true,
      actor: 'test',
    }),
  ).rejects.toThrow('Cancel active')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalGitHubSync, fixture.config)
  await ctx.githubSync.cancel(receipt.runId, 'another instance')
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await fixture.service.run(receipt.runId))?.status).toBe('cancelled')
  expect(await fixture.service.snapshots(fixture.subscription.id)).toEqual([])
})
it('surfaces corrupt pending data as health failure without dispatching it', async () => {
  const fixture = await boot(() => ({ body: [] }))
  const { DatabaseSync } = await import('node:sqlite')
  const sql = new DatabaseSync(fixture.config.databasePath)
  try {
    sql
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?)')
      .run('bad', fixture.subscription.id, 'bad', 'queued', 'null')
    await expect
      .poll(async () => (await fixture.service.storage()).error)
      .toContain('Invalid durable')
    expect(await fixture.service.snapshots(fixture.subscription.id)).toEqual([])
  } finally {
    sql.close()
  }
})
it('rolls back a content commit that exceeds capacity after its response checkpoint was saved', async () => {
  const fixture = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue('x'.repeat(1000))] : [],
  }))
  await fixture.service.setCapacity(3000, 'test')
  const result = await fixture.sync()
  expect(result.status).toBe('failed')
  expect(result.error).toContain('capacity')
  expect((await fixture.service.storage()).blocked).toBe(true)
  await expect(
    fixture.service.sync(fixture.subscription.id, { actor: 'again' }),
  ).rejects.toThrow('capacity')
  expect(await fixture.service.snapshots(fixture.subscription.id)).toEqual([])
})
it('enforces a global concurrency limit while serializing distinct accepted triggers for one subscription', async () => {
  const fixture = await boot(() => ({ status: 429, body: {} }), {
    concurrency: 1,
    retryLimit: 2,
    retryDelayMs: 1000,
  })
  const receipt = await fixture.service.sync(fixture.subscription.id, {
    actor: 'first',
  })
  await expect
    .poll(async () => (await fixture.service.run(receipt.runId))?.status)
    .toBe('waiting')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalGitHubSync, fixture.config)
  const next = await ctx.githubSync.sync(fixture.subscription.id, {
    actor: 'second',
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await ctx.githubSync.run(next.runId))?.status).toBe('queued')
  await ctx.githubSync.cancel(receipt.runId, 'test')
  await ctx.githubSync.cancel(next.runId, 'test')
})
it('blocks a second trigger for a busy subscription even when another global slot is available', async () => {
  const fixture = await boot(() => ({ status: 429, body: {} }), {
    concurrency: 2,
    retryLimit: 2,
    retryDelayMs: 1000,
  })
  const first = await fixture.service.sync(fixture.subscription.id, {
    actor: 'first',
  })
  await expect
    .poll(async () => (await fixture.service.run(first.runId))?.status)
    .toBe('waiting')
  const second = await fixture.service.sync(fixture.subscription.id, {
    actor: 'second',
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await fixture.service.run(second.runId))?.status).toBe('queued')
  await fixture.service.cancel(first.runId, 'test')
  await fixture.service.cancel(second.runId, 'test')
})
it.each([
  { concurrency: 1.5 },
  { apiUrl: 'ftp://example.com' },
  { apiUrl: 'https://user@example.com' },
  { apiUrl: 'https://:secret@example.com' },
])('rejects unsafe provider configuration %j', (patch) => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  expect(() => new LocalGitHubSync(ctx, Config(patch))).toThrow(/Invalid/u)
})
it('atomically retains comment ancestry and rolls back deletion when history would exceed capacity', async () => {
  let comments: unknown[] = [
    {
      id: 2,
      node_id: 'C2',
      body: 'x'.repeat(5000),
      html_url: 'https://github.com/owner/repo/issues/1#comment',
      updated_at: '2026-09-14T00:00:00Z',
    },
  ]
  const fixture = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue()] : comments,
  }))
  await fixture.sync()
  const original = (
    await fixture.service.snapshots(fixture.subscription.id)
  ).find(row => row.kind === 'issue-comment')
  expect(original?.parentId).toBe('issue:I1')
  comments = []
  const usage = await fixture.service.storage()
  await fixture.service.setCapacity(usage.bytes + 3000, 'test')
  const receipt = await fixture.service.sync(fixture.subscription.id, {
    actor: 'test',
    reconcile: true,
  })
  await expect
    .poll(async () => (await fixture.service.run(receipt.runId))?.status)
    .toBe('partial')
  expect((await fixture.service.storage()).blocked).toBe(true)
  expect(
    (await fixture.service.snapshots(fixture.subscription.id)).find(
      row => row.kind === 'issue-comment',
    )?.deleted,
  ).toBe(false)
  await fixture.service.setCapacity(1000000, 'test')
  const retry = await fixture.service.sync(fixture.subscription.id, {
    actor: 'test',
    reconcile: true,
  })
  await expect
    .poll(async () => (await fixture.service.run(retry.runId))?.status)
    .toBe('succeeded')
  const deleted = (
    await fixture.service.snapshots(fixture.subscription.id)
  ).find(row => row.kind === 'issue-comment')
  expect(deleted?.deleted).toBe(true)
  expect(deleted?.parentId).toBe('issue:I1')
})
it('keeps ownership alive independently of a long dispatcher poll interval', async () => {
  let count = 0
  const fixture = await boot(
    () => {
      count++
      return count === 1 ? { status: 429, body: {} } : { body: [] }
    },
    { leaseMs: 100, pollIntervalMs: 60000, retryLimit: 1, retryDelayMs: 250 },
  )
  expect((await fixture.sync()).status).toBe('succeeded')
})
it('explicitly resumes the same page-budget-limited receipt and retains its committed checkpoints', async () => {
  let firstPageCalls = 0
  const fixture = await boot(
    (url) => {
      if (url.pathname.endsWith('/issues')) firstPageCalls++
      return { body: url.pathname.endsWith('/issues') ? [issue()] : [] }
    },
    { maxPages: 1 },
  )
  const run = await fixture.sync()
  expect(run.status).toBe('partial')
  const receipt = await fixture.service.resumeRun(run.id, 'resumer')
  expect(receipt.runId).toBe(run.id)
  await expect
    .poll(async () => (await fixture.service.run(run.id))?.status)
    .toBe('succeeded')
  expect(firstPageCalls).toBe(1)
  expect(await fixture.service.runs()).toHaveLength(1)
  await expect(fixture.service.resumeRun(run.id, 'resumer')).rejects.toThrow(
    'Only failed',
  )
  await expect(fixture.service.resumeRun('missing', 'resumer')).rejects.toThrow(
    'Unknown run',
  )
})
it('persists capacity audit and requires explicit unblock before resuming a failed receipt', async () => {
  const fixture = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue('x'.repeat(1000))] : [],
  }))
  await fixture.service.setCapacity(3000, 'operator')
  const run = await fixture.sync()
  expect(run.status).toBe('failed')
  await expect(fixture.service.resumeRun(run.id, 'operator')).rejects.toThrow(
    'capacity',
  )
  await fixture.service.setCapacity(1000000, 'capacity-owner')
  expect((await fixture.service.storage()).capacityChangedBy).toBe(
    'capacity-owner',
  )
  await fixture.service.resumeRun(run.id, 'operator')
  await expect
    .poll(async () => (await fixture.service.run(run.id))?.status)
    .toBe('succeeded')
})
it('persists cancellation before acceptance so a delayed original delivery never starts GitHub work', async () => {
  let requests = 0
  const fixture = await boot(() => {
    requests++
    return { body: [] }
  })
  await fixture.service.updateSubscription(fixture.subscription.id, {
    paused: true,
    actor: 'test',
  })
  await fixture.service.setCapacity(1, 'test')
  const receipt = await fixture.service.sync(fixture.subscription.id, {
    actor: 'scheduler',
    triggerId: 'cancel-first',
    cancelRequested: true,
  })
  expect((await fixture.service.run(receipt.runId))?.status).toBe('cancelled')
  expect(
    await fixture.service.sync(fixture.subscription.id, {
      actor: 'scheduler',
      triggerId: 'cancel-first',
    }),
  ).toEqual(receipt)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(requests).toBe(0)
  await expect(
    fixture.service.resumeRun(receipt.runId, 'operator'),
  ).rejects.toThrow('Only failed')
})
it('rejects stale resume after a newer run changes content or the subscription scope changes', async () => {
  let body = 'old'
  const fixture = await boot(
    url => ({ body: url.pathname.endsWith('/issues') ? [issue(body)] : [] }),
    { maxPages: 1 },
  )
  const old = await fixture.sync()
  expect(old.status).toBe('partial')
  body = 'new'
  const newer = await fixture.sync()
  expect(newer.status).toBe('partial')
  await expect(fixture.service.resumeRun(old.id, 'operator')).rejects.toThrow(
    'Newer synchronization',
  )
  expect(
    (await fixture.service.snapshots(fixture.subscription.id))[0]?.body,
  ).toBe('new')
  await fixture.service.updateSubscription(fixture.subscription.id, {
    discussions: true,
    actor: 'operator',
  })
  await expect(fixture.service.resumeRun(newer.id, 'operator')).rejects.toThrow(
    'scope changed',
  )
})
it('cancels an existing durable receipt through repeat acceptance', async () => {
  const fixture = await boot(() => ({ status: 429, body: {} }), {
    retryLimit: 2,
    retryDelayMs: 1000,
  })
  const receipt = await fixture.service.sync(fixture.subscription.id, {
    actor: 'scheduler',
    triggerId: 'existing',
  })
  await expect
    .poll(async () => (await fixture.service.run(receipt.runId))?.status)
    .toBe('waiting')
  expect(
    await fixture.service.sync(fixture.subscription.id, {
      actor: 'scheduler',
      triggerId: 'existing',
      cancelRequested: true,
    }),
  ).toEqual(receipt)
  expect((await fixture.service.run(receipt.runId))?.status).toBe('cancelled')
})
it('prevents already queued work from starting HTTP after an earlier run exhausts capacity', async () => {
  let requests = 0
  const fixture = await boot(
    () => {
      requests++
      return { body: [] }
    },
    { concurrency: 1 },
  )
  const first = await fixture.service.sync(fixture.subscription.id, {
    actor: 'first',
  })
  const second = await fixture.service.sync(fixture.subscription.id, {
    actor: 'second',
  })
  await fixture.service.setCapacity(1, 'operator')
  await expect
    .poll(async () => (await fixture.service.run(first.runId))?.status)
    .toBe('failed')
  await expect
    .poll(async () => (await fixture.service.run(second.runId))?.status)
    .toBe('failed')
  expect(requests).toBe(1)
})
it('rejects a non-text durable change instead of returning a corrupt consumer record', async () => {
  const fixture = await boot(url => ({
    body: url.pathname.endsWith('/issues') ? [issue()] : [],
  }))
  await fixture.sync()
  await fixture.service.registerConsumer(
    fixture.subscription.id,
    'reader',
    'beginning',
  )
  const { DatabaseSync } = await import('node:sqlite')
  const sql = new DatabaseSync(fixture.config.databasePath)
  try {
    sql.prepare('UPDATE changes SET data=?').run(new Uint8Array([1]))
    await expect(
      fixture.service.readChanges(fixture.subscription.id, 'reader', 10),
    ).rejects.toThrow('Invalid change')
  } finally {
    sql.close()
  }
})
it('rejects resuming a partial run while a newer run has not yet committed its first page', async () => {
  let waiting = false
  const fixture = await boot(
    url =>
      waiting
        ? { status: 429, body: {} }
        : { body: url.pathname.endsWith('/issues') ? [issue()] : [] },
    { maxPages: 1, retryLimit: 2, retryDelayMs: 1000 },
  )
  const old = await fixture.sync()
  expect(old.status).toBe('partial')
  waiting = true
  const newer = await fixture.service.sync(fixture.subscription.id, {
    actor: 'newer',
  })
  await expect
    .poll(async () => (await fixture.service.run(newer.runId))?.status)
    .toBe('waiting')
  await expect(fixture.service.resumeRun(old.id, 'operator')).rejects.toThrow(
    'Another synchronization is pending',
  )
  await fixture.service.cancel(newer.runId, 'operator')
})
it('retains partial content when credentials disappear before explicit resume', async () => {
  const key = 'DSH_GITHUB_SYNC_RESUME_TEST_TOKEN'
  const previous = process.env[key]
  process.env[key] = 'fixture-only-token'
  try {
    const fixture = await boot(url => ({
      body: url.pathname.endsWith('/issues') ? [issue()] : [],
    }), { maxPages: 1 })
    await fixture.service.updateSubscription(fixture.subscription.id, {
      issues: true, discussions: false, credentialRef: `env:${key}`, actor: 'operator',
    })
    const run = await fixture.sync()
    expect(run.status).toBe('partial')
    delete process.env.DSH_GITHUB_SYNC_RESUME_TEST_TOKEN
    await fixture.service.resumeRun(run.id, 'operator')
    await expect.poll(async () => (await fixture.service.run(run.id))?.status).toBe('partial')
    expect((await fixture.service.run(run.id))?.error).toBe('Credential reference unavailable')
    expect(await fixture.service.snapshots(fixture.subscription.id)).toHaveLength(1)
  } finally {
    if (previous === undefined) delete process.env.DSH_GITHUB_SYNC_RESUME_TEST_TOKEN
    else process.env[key] = previous
  }
})
it('disposes immediately without allowing queued startup work to touch closed storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-immediate-disposal-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const callbacks: Array<() => void> = []
  const microtasks = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    callbacks.push(callback)
  })
  try {
    new LocalGitHubSync(ctx, Config({ databasePath: join(root, 'state.sqlite') }))
  } finally {
    microtasks.mockRestore()
  }
  await ctx.fiber.dispose()
  expect(callbacks.length).toBeGreaterThan(0)
  for (const callback of callbacks) expect(callback).not.toThrow()
})
it('enforces project ownership across subscription content, runs, and durable consumers', async () => {
  const { service, subscription, sync } = await boot(() => ({ body: [] }))
  const id = subscription.id
  const run = await sync()
  expect(await service.subscriptions('other')).toEqual([])
  expect(await service.runs(undefined, 'other')).toEqual([])
  expect(await service.runs(id, 'test-project')).toHaveLength(1)
  expect(await service.run(run.id, 'test-project')).toMatchObject({ id: run.id })
  await service.registerConsumer(id, 'consumer', 'beginning', 'test-project')
  for (const operation of [
    () => service.updateSubscription(id, { actor: 'x', paused: true }, 'other'),
    () => service.sync(id, { actor: 'x', triggerId: run.triggerId }, 'other'),
    () => service.run(run.id, 'other'),
    () => service.runs(id, 'other'),
    () => service.cancel(run.id, 'x', 'other'),
    () => service.resumeRun(run.id, 'x', 'other'),
    () => service.snapshots(id, 'other'),
    () => service.registerConsumer(id, 'evil', 'beginning', 'other'),
    () => service.readChanges(id, 'consumer', 10, 'other'),
    () => service.acknowledge(id, 'consumer', 1, 'other'),
    () => service.replay(id, 'consumer', 'now', 'other'),
    () => service.consumerState(id, 'consumer', 'other'),
    () => consumePage(service, id, 'consumer', 10, async () => { throw new Error('Cross-project content reached consumer') }, 'other'),
  ]) await expect(operation()).rejects.toThrow('Unknown subscription')
  expect(() => service.watch(id, () => {}, 'other')).toThrow('Unknown subscription')
  await expect(service.updateSubscription(id, { actor: 'x', projectId: 'other' }, 'test-project')).rejects.toThrow('PROJECT_MISMATCH')
  await expect(service.createSubscription({ projectId: '', repository: 'a/b', actor: 'x', issues: true, discussions: false })).rejects.toThrow('non-empty')
})
it('retains legacy subscriptions unassigned and claims them atomically with runs requiring explicit resume', async () => {
  const { service, subscription, sync } = await boot(() => ({ body: [] }))
  await sync()
  const run = await sync()
  const db = (service as LocalGitHubSync).db
  db.sql.prepare("UPDATE subscriptions SET data=json_remove(data,'$.projectId') WHERE id=?").run(subscription.id)
  db.sql.prepare("UPDATE runs SET status='queued',data=json_set(json_remove(data,'$.subscriptionSnapshot.projectId'),'$.status','queued') WHERE id=?").run(run.id)
  expect(await service.unassignedSubscriptions()).toHaveLength(1)
  await expect(service.sync(subscription.id, { actor: 'x' })).rejects.toThrow('PROJECT_REQUIRED')
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await service.run(run.id))?.status).toBe('queued')
  const claimed = await service.claimSubscription(subscription.id, 'new-project', 'claimant')
  expect(claimed).toMatchObject({ projectId: 'new-project', paused: true, actor: 'claimant' })
  expect(await service.run(run.id, 'new-project')).toMatchObject({ status: 'failed', error: 'PROJECT_CLAIM_REQUIRES_RESUME' })
  await expect(service.claimSubscription(subscription.id, 'other', 'x')).rejects.toThrow('PROJECT_ALREADY_ASSIGNED')
  expect(await service.unassignedSubscriptions()).toEqual([])
})
it('rejects cross-project scheduled subscription links at creation, update, and delivery', async () => {
  const { ctx, service, config, subscription } = await boot(() => ({ body: [] }))
  await ctx.plugin(LocalScheduler, { databasePath: `${config.databasePath}.scheduler`, pollIntervalMs: 60000 })
  const input = { projectId: 'other', name: 'sync', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval' as const, everyMs: 60000 } }
  await expect(ctx.scheduler.create(input, 'actor')).rejects.toThrow('PROJECT_MISMATCH')
  const plan = await ctx.scheduler.create({ ...input, projectId: 'test-project' }, 'actor')
  const other = await service.createSubscription({ projectId: 'other', repository: 'a/b', actor: 'actor', issues: true, discussions: false })
  await expect(ctx.scheduler.update(plan.id, { ...input, projectId: 'test-project', params: { subscriptionId: other.id } }, 'actor', 'test-project')).rejects.toThrow('PROJECT_MISMATCH')
  const trigger = await ctx.scheduler.trigger(plan.id, 'actor', 'test-project')
  const db = (service as LocalGitHubSync).db
  db.sql.prepare("UPDATE subscriptions SET data=json_set(data,'$.projectId','other') WHERE id=?").run(subscription.id)
  await ctx.scheduler.tick()
  expect((await ctx.scheduler.history(plan.id, 'test-project'))[0]).toMatchObject({ id: trigger.id, error: 'DELIVERY_FAILED' })
  expect(await service.runs()).toEqual([])
})
