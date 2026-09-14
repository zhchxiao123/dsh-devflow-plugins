import { installProjectHost, createProjectSession } from '../../../tests/automation-project-host.ts'
/// <reference types="node" />
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it } from 'vitest'
import { emptyInbox } from '../../../tests/agent-double.ts'
import LocalGitHubSync from '../src/index.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-command-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  let failOnce = true
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/repos/owner/fail/issues' && failOnce) {
      failOnce = false
      response.writeHead(503)
      response.end('{}')
      return
    }
    response.end(JSON.stringify(path.endsWith('/issues') ? [{
      id: 1, node_id: 'I_1', number: 1, title: 'Command fixture', body: 'Read-only input', state: 'open',
      html_url: 'https://github.com/owner/repo/issues/1', updated_at: '2026-09-14T00:00:00Z',
    }] : []))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture did not listen')
  cleanup.push(() => ctx.fiber.dispose())
  await installProjectHost(ctx, root)
  await ctx.plugin(Commands)
  await ctx.plugin(Agents)
  const fiber = await ctx.plugin(LocalGitHubSync, { databasePath: join(root, 'github.sqlite'), pollIntervalMs: 60_000, apiUrl: `http://127.0.0.1:${address.port}`, retryLimit: 0 })
  const scope = ctx.plugin(() => {})
  const { session } = await createProjectSession(ctx, root, 'github-sync-command')
  const agent: Agent = {
    id: session.id, session, ctx: scope.ctx, options: {}, inbox: emptyInbox(), status: 'idle',
    followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  async function run(input: string) {
    const execution = await ctx.commands.execute(agent, `/github-sync ${input}`, [], new AbortController().signal)
    if (execution === undefined) throw new Error('github-sync command missing')
    return execution.result
  }
  return { ctx, fiber, agent, run }
}

it('lists subscriptions without arguments and rejects surplus or invalid arguments before mutations', async () => {
  const { run, ctx } = await boot()
  expect((await run('')).kind).toBe('success')
  for (const invalid of ['list extra', 'storage extra', 'sync missing extra', 'add owner/repo invalid', 'update missing invalid', 'add owner/repo issues env:TOKEN extra', 'consumer a b later', 'replay a b later', 'not-a-command', 'add', 'capacity nope', 'resume-run missing']) {
    expect((await run(invalid)).kind, invalid).toBe('error')
  }
  expect(await ctx.githubSync.subscriptions()).toEqual([])
})

it('manages subscriptions, runs and independent consumers through the actual command runtime', async () => {
  const { run, ctx, fiber, agent } = await boot()
  expect((await run('add owner/repo')).kind).toBe('success')
  expect((await run('add owner/discussions discussions env:TEST_GITHUB_TOKEN')).kind).toBe('success')
  expect((await run('add owner/all all')).kind).toBe('success')
  const [subscription] = await ctx.githubSync.subscriptions()
  if (subscription === undefined) throw new Error('No subscription created')
  expect(subscription.actor).toContain('github-sync-command')
  expect((await run(`update ${subscription.id} all`)).kind).toBe('success')
  expect((await ctx.githubSync.subscriptions()).find(item => item.id === subscription.id)?.discussions).toBe(true)
  expect((await run(`update ${subscription.id} issues`)).kind).toBe('success')
  const credentials = (await ctx.githubSync.subscriptions()).find(item => item.repository === 'owner/discussions')
  if (credentials === undefined) throw new Error('Missing credential subscription')
  expect((await run(`update ${credentials.id} discussions env:REPLACEMENT_GITHUB_TOKEN`)).kind).toBe('success')
  expect((await ctx.githubSync.subscriptions()).find(item => item.id === credentials.id)?.credentialRef).toBe('env:REPLACEMENT_GITHUB_TOKEN')
  for (const input of [
    'list', `pause ${subscription.id}`, `resume ${subscription.id}`, `content ${subscription.id}`, 'storage', 'capacity 10485760',
    `consumer ${subscription.id} summary beginning`, `changes ${subscription.id} summary 20`, `cursor ${subscription.id} summary`,
    `replay ${subscription.id} summary now`, `consumer ${subscription.id} recent now`, `replay ${subscription.id} recent beginning`,
    'runs', `runs ${subscription.id}`, `sync ${subscription.id}`,
  ]) expect((await run(input)).kind, input).toBe('success')
  const [syncRun] = await ctx.githubSync.runs(subscription.id)
  if (syncRun === undefined) throw new Error('No run accepted')
  expect((await run(`show ${syncRun.id}`)).text).toContain(syncRun.id)
  expect((await run('show missing-run')).text).toBe('null')
  await expect.poll(async () => (await ctx.githubSync.run(syncRun.id))?.status).toBe('succeeded')
  expect((await run(`cancel ${syncRun.id}`)).kind).toBe('success')
  expect((await run(`ack ${subscription.id} summary 1`)).kind).toBe('error')
  expect((await run(`changes ${subscription.id} summary 100`)).kind).toBe('success')
  const [change] = await ctx.githubSync.readChanges(subscription.id, 'summary', 100)
  if (change === undefined) throw new Error('Expected a durable change')
  expect((await run(`ack ${subscription.id} summary ${change.sequence}`)).kind).toBe('success')
  await fiber.dispose()
  expect(await ctx.commands.execute(agent, '/github-sync list', [], new AbortController().signal)).toBeUndefined()
})

it('resumes a failed run from the command plane using its original receipt', async () => {
  const { ctx, run } = await boot()
  expect((await run('add owner/fail')).kind).toBe('success')
  const [subscription] = await ctx.githubSync.subscriptions()
  if (subscription === undefined) throw new Error('Missing subscription')
  expect((await run(`sync ${subscription.id}`)).kind).toBe('success')
  const [original] = await ctx.githubSync.runs(subscription.id)
  if (original === undefined) throw new Error('Missing run')
  await expect.poll(async () => (await ctx.githubSync.run(original.id))?.status).toBe('failed')
  expect((await run(`resume-run ${original.id}`)).kind).toBe('success')
  await expect.poll(async () => (await ctx.githubSync.run(original.id))?.status).toBe('succeeded')
  expect(await ctx.githubSync.runs(subscription.id)).toHaveLength(1)
})
