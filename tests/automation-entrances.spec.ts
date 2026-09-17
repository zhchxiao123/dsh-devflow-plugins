/** Tools and the browser face act on one durable state through a real Loader. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
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
      { name: 'storage' }, { name: 'storage-json', config: { root: join(root, 'storage') } },
      { name: 'storage-domain', config: { backend: 'json' } },
      { name: 'session-persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: 'sessions' }, { name: 'workspaces' },
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
      ['storage', Storage], ['storage-json', StorageJson], ['storage-domain', StorageDomain],
      ['session-persistence', SessionPersistence], ['sessions', SessionStore], ['workspaces', WorkspaceRegistry],
      ['agents', AgentRegistry], ['prompt', SystemPrompt], ['tools', Tools],
      ['scheduler', Scheduler], ['github', GitHub], ['scheduler-tools', SchedulerTools],
      ['github-tools', GitHubTools], ['server', WebServer], ['web', AutomationWeb],
    ])
    ctx.loader.internal = { version: 'v2', async import(name: string) { return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    globalThis.fetch = (input, init) => originalFetch(input === '/automation/api' ? `http://127.0.0.1:${ctx.webServer.port}/automation/api` : input, init)
    const projectPath = join(root, 'project-a')
    const otherPath = join(root, 'project-b')
    await mkdir(projectPath)
    await mkdir(otherPath)
    const project = await ctx.workspaceRegistry.create(projectPath, 'Project A')
    const otherProject = await ctx.workspaceRegistry.create(otherPath, 'Project B')
    const id = SessionId('automation-entrances-owner')
    const owner: Agent = {
      id, options: {}, session: ctx.sessions.create(id, { meta: { cwd: projectPath } }), inbox: emptyInbox(), status: 'idle', ctx,
      followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    const siblingId = SessionId('same-project-session')
    ctx.sessions.create(siblingId, { meta: { cwd: projectPath } })
    const otherId = SessionId('other-project-session')
    const otherOwner: Agent = { ...owner, id: otherId, session: ctx.sessions.create(otherId, { meta: { cwd: otherPath } }) }
    ctx.agents.register(otherOwner)
    const noProjectId = SessionId('no-project-session')
    ctx.sessions.create(noProjectId)
    let sequence = 0
    const tool = async (name: string, args: object) => ctx.tools.execute({ name, arguments: args, agent: owner, callId: ToolCallId(`entrances-${++sequence}`), signal: new AbortController().signal })
    const configured = await tool('github_sync_configure', { repository: 'owner/repo', issues: true, discussions: false })
    expect(configured.isError).toBe(false)
    const initial = await automationRequest({ sessionId: id, method: 'overview' })
    expect(initial.project).toMatchObject({ id: project.id, title: 'Project A' })
    expect(initial.subscriptions).toHaveLength(1)
    expect((await automationRequest({ sessionId: siblingId, method: 'overview' })).subscriptions).toEqual(initial.subscriptions)
    const emptyOther = await automationRequest({ sessionId: otherId, method: 'overview' })
    expect(emptyOther.project.id).toBe(otherProject.id)
    expect(emptyOther.subscriptions).toEqual([])
    await expect(automationRequest({ sessionId: noProjectId, method: 'overview' })).rejects.toThrow()
    await expect(automationRequest({ sessionId: 'unknown-session', method: 'overview' })).rejects.toThrow()
    const subscription = initial.subscriptions[0]!
    expect(subscription).toMatchObject({ repository: 'owner/repo', paused: false })
    expect(subscription.actor).toContain('agent:automation-entrances-owner')
    expect((await tool('scheduler_configure', { name: 'Repository intake', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval', everyMs: 3600000 } })).isError).toBe(false)
    const overview = await automationRequest({ sessionId: id, method: 'overview' })
    expect(overview.plans).toHaveLength(1)
    const plan = overview.plans[0]!
    expect((await automationRequest({ sessionId: otherId, method: 'overview' })).plans).toEqual([])
    await expect(automationRequest({ sessionId: otherId, method: 'plan.action', id: plan.id, action: 'pause' })).rejects.toThrow()
    await expect(automationRequest({ sessionId: otherId, method: 'subscription.action', id: subscription.id, action: 'sync' })).rejects.toThrow()
    await expect(automationRequest({ sessionId: otherId, method: 'content', subscriptionId: subscription.id })).rejects.toThrow()
    const crossQuery = await ctx.tools.execute({ name: 'github_sync_content', arguments: { subscriptionId: subscription.id }, agent: otherOwner, callId: ToolCallId('cross-project-content'), signal: new AbortController().signal })
    expect(crossQuery.isError).toBe(true)
    const crossPlan = await ctx.tools.execute({ name: 'scheduler_configure', arguments: { name: 'Cross project', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval', everyMs: 3600000 } }, agent: otherOwner, callId: ToolCallId('cross-project-plan'), signal: new AbortController().signal })
    expect(crossPlan.isError).toBe(true)
    await automationRequest({ sessionId: id, method: 'plan.action', id: plan.id, action: 'pause' })
    const query = await tool('scheduler_query', { planId: plan.id })
    expect(query.isError).toBe(false)
    expect(query.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('"enabled": false') })]))
    await automationRequest({ sessionId: id, method: 'subscription.action', id: subscription.id, action: 'pause' })
    expect((await automationRequest({ sessionId: id, method: 'overview' })).subscriptions[0]?.paused).toBe(true)
    expect((await tool('github_sync_subscription_manage', { subscriptionId: subscription.id, action: 'resume' })).isError).toBe(false)
    const final = await automationRequest({ sessionId: id, method: 'overview' })
    expect(final.subscriptions[0]?.paused).toBe(false)
    expect(final.plans[0]?.enabled).toBe(false)
    expect(final.runs).toEqual([])
    expect((await tool('github_sync_start', { subscriptionId: subscription.id })).isError).toBe(false)
    await expect.poll(async () => (await automationRequest({ sessionId: id, method: 'overview' })).runs[0]?.status).toBe('failed')
    const failed = (await automationRequest({ sessionId: id, method: 'overview' })).runs[0]!
    expect((await automationRequest({ sessionId: otherId, method: 'overview' })).runs).toEqual([])
    await expect(automationRequest({ sessionId: otherId, method: 'run.action', id: failed.id, action: 'resume' })).rejects.toThrow()
    await expect(automationRequest({ sessionId: otherId, method: 'run.action', id: failed.id, action: 'cancel' })).rejects.toThrow()
    failGitHub = false
    await automationRequest({ sessionId: id, method: 'run.action', id: failed.id, action: 'resume' })
    await expect.poll(async () => (await automationRequest({ sessionId: id, method: 'overview' })).runs[0]?.status).toBe('succeeded')
    const resumedQuery = await tool('github_sync_runs', { runId: failed.id })
    expect(resumedQuery.isError).toBe(false)
    expect(resumedQuery.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('"status": "succeeded"') })]))
    expect((await automationRequest({ sessionId: id, method: 'overview' })).runs).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    await ctx.fiber.dispose()
    await new Promise<void>(resolve => external.close(() => { resolve() }))
    await rm(root, { recursive: true, force: true })
  }
})
