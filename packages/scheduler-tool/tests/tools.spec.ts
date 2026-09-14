/// <reference types="node" />
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import LocalScheduler from '@zhchxiao123/dsh-scheduler-local'
import { emptyInbox } from '../../../tests/agent-double.ts'
import * as SchedulerTools from '../src/index.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'scheduler-tool-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['agents', Agents], ['system', SystemPrompt], ['tools', Tools], ['scheduler', LocalScheduler], ['consumer', SchedulerTools],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) { return modules.get(specifier) },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  const config = join(dir, 'cordis.yml')
  await writeFile(config, `- name: agents\n- name: system\n- name: tools\n- name: scheduler\n  config:\n    databasePath: ${JSON.stringify(join(dir, 'state.sqlite'))}\n    pollIntervalMs: 60000\n- name: consumer\n`)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const session = Session.create(SessionId('scheduler-tool-owner'))
  const agent: Agent = {
    id: session.id, session, ctx: ctx.plugin(() => {}).ctx, options: {}, inbox: emptyInbox(), status: 'idle',
    followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  async function call(name: string, args: object, owner: Agent | undefined = agent) {
    const result = await ctx.tools.execute({ name, arguments: args, callId: ToolCallId('scheduler-test-call'), signal: new AbortController().signal, ...owner === undefined ? {} : { agent: owner } })
    const definition = ctx.tools.get(name)
    const pending = definition?.presentCall?.(args)
    const view = definition?.presentResult?.(args, { content: result.content, isError: result.isError })
    return { result, pending, view, text: result.content.filter(block => block.type === 'text').map(block => block.text).join('') }
  }
  return { ctx, call, agent }
}
const plan = { name: 'Scan repo', handler: 'github.sync', params: { subscriptionId: 'subscription-1' }, rule: { kind: 'interval', everyMs: 3600000 } }
it('creates and edits real durable plans through Loader-registered tools with native cards and actual actor identity', async () => {
  const { ctx, call } = await boot()
  expect((await call('scheduler_query', {})).text).toContain('0 plans')
  const saved = await call('scheduler_configure', { ...plan, actor: 'forged' })
  expect(saved.result.isError, saved.text).toBe(false)
  expect(saved.pending).toMatchObject({ card: 'generic', kind: 'edit', title: '保存定时计划：Scan repo' })
  expect(JSON.stringify(saved.view)).not.toContain('subscription-1')
  const [created] = await ctx.scheduler.list()
  if (created === undefined) throw new Error('Plan was not persisted')
  expect(created.createdBy).toBe('agent:scheduler-tool-owner/tool:scheduler-test-call')
  expect((await call('scheduler_configure', { ...plan, planId: created.id, name: 'Cron scan', rule: { kind: 'cron', expression: '0 */2 * * *', timezone: 'UTC' }, misfire: 'skip', maxAttempts: 4, timeoutMs: 1000 })).result.isError).toBe(false)
  expect((await call('scheduler_query', { planId: created.id })).text).toContain('Cron scan')
  expect((await call('scheduler_query', { planId: 'missing' })).text).toContain('0 plans')
  for (const action of ['pause', 'resume', 'delete']) {
    expect((await call('scheduler_manage', { planId: created.id, action })).result.isError).toBe(false)
  }
  expect(await ctx.scheduler.list()).toEqual([])
  expect((await call('scheduler_configure', { ...plan, rule: { kind: 'cron', expression: 'bad', timezone: 'invalid' } })).result.isError).toBe(true)
  expect((await call('scheduler_configure', { ...plan, rule: { kind: 'interval', everyMs: 0 } })).result.isError).toBe(true)
  expect((await call('scheduler_configure', { name: 'invalid' })).result.isError).toBe(true)
  const withoutAgent = await ctx.tools.execute({ name: 'scheduler_configure', arguments: plan, callId: ToolCallId('anonymous'), signal: new AbortController().signal })
  expect(withoutAgent.isError).toBe(true)
  expect(ctx.tools.get('scheduler_query')?.isConcurrencySafe?.({})).toBe(true)
})
it('returns enqueue/cancellation receipts without claiming downstream completion and unregisters on disposal', async () => {
  const { ctx, call } = await boot()
  await call('scheduler_configure', plan)
  const [created] = await ctx.scheduler.list()
  if (created === undefined) throw new Error('Missing plan')
  const accepted = await call('scheduler_trigger', { action: 'start', id: created.id })
  expect(accepted.result.isError).toBe(false)
  expect(accepted.text).toContain('not downstream completion')
  const [trigger] = await ctx.scheduler.history(created.id)
  if (trigger === undefined) throw new Error('Missing trigger')
  expect(trigger.requestedBy).toContain('scheduler-tool-owner')
  expect((await call('scheduler_trigger', { action: 'cancel', id: trigger.id })).text).toContain('cancellation-requested')
  expect((await ctx.scheduler.history(created.id))[0]?.state).toBe('cancelled')
  const failed = await call('scheduler_manage', { action: 'pause', planId: 'missing' })
  expect(failed.view).toMatchObject({ title: '调度操作失败' })
  const definition = ctx.tools.get('scheduler_query')
  expect(definition?.presentResult?.({}, { isError: false, content: [{ type: 'reasoning', text: 'not visible result content' }] })).toMatchObject({ card: 'generic' })
  const runtime = ctx.tools
  await ctx.fiber.dispose()
  expect(runtime.get('scheduler_configure')).toBeUndefined()
})
