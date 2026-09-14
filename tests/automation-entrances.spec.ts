/** Tools and the browser face act on one durable state through a real Loader. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Scheduler from '@zhchxiao123/dsh-scheduler-local'
import GitHub from '@zhchxiao123/dsh-github-sync-local'
import * as SchedulerTools from '@zhchxiao123/dsh-scheduler-tool'
import * as GitHubTools from '@zhchxiao123/dsh-github-sync-tool'
import * as AutomationWeb from '@zhchxiao123/dsh-automation-web'
import { automationRequest } from '@zhchxiao123/dsh-automation-web/client'
import { emptyInbox } from './agent-double.ts'
import { expect, it } from 'vitest'

it('reflects tool configuration in the panel and panel changes in subsequent tool queries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automation-entrances-'))
  const ctx = new Context()
  let failGitHub = true
  const external = createServer((_req, res) => {
    res.writeHead(failGitHub ? 500 : 200, { 'content-type': 'application/json' })
    res.end('[]')
  })
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve))
  const externalAddress = external.address()
  if (externalAddress === null || typeof externalAddress === 'string') throw new Error('fixture did not listen')
  const originalFetch = globalThis.fetch
  try {
    const config = join(root, 'cordis.yml')
    await writeFile(config, JSON.stringify([
      { name: 'agents' }, { name: 'prompt' }, { name: 'tools' },
      { name: 'scheduler', config: { databasePath: join(root, 'scheduler.db'), pollIntervalMs: 60000 } },
      { name: 'github', config: { databasePath: join(root, 'github.db'), pollIntervalMs: 10, retryLimit: 0, apiUrl: `http://127.0.0.1:${externalAddress.port}` } },
      { name: 'scheduler-tools' }, { name: 'github-tools' },
      { name: 'server', config: { host: '127.0.0.1', port: 0 } }, { name: 'web' },
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['prompt', SystemPrompt], ['tools', Tools],
      ['scheduler', Scheduler], ['github', GitHub], ['scheduler-tools', SchedulerTools],
      ['github-tools', GitHubTools], ['server', WebServer], ['web', AutomationWeb],
    ])
    ctx.loader.internal = { version: 'v2', async import(name: string) { return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    globalThis.fetch = (input, init) => originalFetch(input === '/automation/api' ? `http://127.0.0.1:${ctx.webServer.port}/automation/api` : input, init)
    const id = SessionId('automation-entrances-owner')
    const owner: Agent = {
      id, options: {}, session: Session.create(id), inbox: emptyInbox(), status: 'idle', ctx,
      followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    let sequence = 0
    const tool = async (name: string, args: object) => ctx.tools.execute({ name, arguments: args, agent: owner, callId: ToolCallId(`entrances-${++sequence}`), signal: new AbortController().signal })
    const configured = await tool('github_sync_configure', { repository: 'owner/repo', issues: true, discussions: false })
    expect(configured.isError).toBe(false)
    const initial = await automationRequest({ method: 'overview' })
    expect(initial.subscriptions).toHaveLength(1)
    const subscription = initial.subscriptions[0]!
    expect(subscription).toMatchObject({ repository: 'owner/repo', paused: false })
    expect(subscription.actor).toContain('agent:automation-entrances-owner')
    expect((await tool('scheduler_configure', { name: 'Repository intake', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval', everyMs: 3600000 } })).isError).toBe(false)
    const overview = await automationRequest({ method: 'overview' })
    expect(overview.plans).toHaveLength(1)
    const plan = overview.plans[0]!
    await automationRequest({ method: 'plan.action', id: plan.id, action: 'pause' })
    const query = await tool('scheduler_query', { planId: plan.id })
    expect(query.isError).toBe(false)
    expect(query.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('"enabled": false') })]))
    await automationRequest({ method: 'subscription.action', id: subscription.id, action: 'pause' })
    expect((await automationRequest({ method: 'overview' })).subscriptions[0]?.paused).toBe(true)
    expect((await tool('github_sync_subscription_manage', { subscriptionId: subscription.id, action: 'resume' })).isError).toBe(false)
    const final = await automationRequest({ method: 'overview' })
    expect(final.subscriptions[0]?.paused).toBe(false)
    expect(final.plans[0]?.enabled).toBe(false)
    expect(final.runs).toEqual([])
    expect((await tool('github_sync_start', { subscriptionId: subscription.id })).isError).toBe(false)
    await expect.poll(async () => (await automationRequest({ method: 'overview' })).runs[0]?.status).toBe('failed')
    const failed = (await automationRequest({ method: 'overview' })).runs[0]!
    failGitHub = false
    await automationRequest({ method: 'run.action', id: failed.id, action: 'resume' })
    await expect.poll(async () => (await automationRequest({ method: 'overview' })).runs[0]?.status).toBe('succeeded')
    const resumedQuery = await tool('github_sync_runs', { runId: failed.id })
    expect(resumedQuery.isError).toBe(false)
    expect(resumedQuery.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('"status": "succeeded"') })]))
    expect((await automationRequest({ method: 'overview' })).runs).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    await ctx.fiber.dispose()
    await new Promise<void>(resolve => external.close(() => { resolve() }))
    await rm(root, { recursive: true, force: true })
  }
})
