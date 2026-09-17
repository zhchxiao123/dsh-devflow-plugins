import { registerValidationHandler } from '../../../tests/scheduler-validation-handler.ts'
import { installProjectHost, createProjectSession } from '../../../tests/automation-project-host.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Agents from '@deepseek-ai/dsh-agent'
import Invariants from '@deepseek-ai/dsh-invariants'
import { expect, it } from 'vitest'
import { emptyInbox } from '../../../tests/agent-double.ts'
import LocalScheduler from '../src/index.ts'
import * as localInvariant from '../src/invariant.ts'
import * as definitionInvariant from '../../scheduler/src/invariant.ts'
it('manages schedules from the actual command runtime and removes contributions on unload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheduler-command-'))
  const ctx = new Context()
  try {
    await installProjectHost(ctx, root)
    await ctx.plugin(Commands)
    await ctx.plugin(Agents)
    await ctx.plugin(Invariants, { enabled: true })
    const a = await ctx.plugin(localInvariant)
    const b = await ctx.plugin(definitionInvariant)
    const fiber = await ctx.plugin(LocalScheduler, { databasePath: join(root, 'db'), pollIntervalMs: 60000 })
    const scope = ctx.plugin(() => {})
    registerValidationHandler(ctx.scheduler, 'clock')
    const { session } = await createProjectSession(ctx, root, 'scheduler-command')
    const agent: Agent = {
      id: session.id,
      session,
      ctx: scope.ctx,
      options: {},
      inbox: emptyInbox(),
      status: 'idle',
      followup() {},
      steer() {},
      inject() {},
      send() {},
      cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(agent)
    async function run(input: string) {
      const execution = await ctx.commands.execute(agent, `/scheduler ${input}`, [], new AbortController().signal)
      if (!execution) throw new Error('COMMAND_MISSING')
      return execution.result
    }
    const input = { name: 'clock', projectId: 'test-project', handler: 'clock', params: {}, rule: { kind: 'interval', everyMs: 1000 } }
    expect((await run('')).kind).toBe('success')
    expect((await run('list')).kind).toBe('success')
    expect((await run(`create ${JSON.stringify(input)}`)).kind).toBe('success')
    const plan = (await ctx.scheduler.list())[0]
    if (!plan) throw new Error('PLAN_MISSING')
    expect((await run(`update ${plan.id} ${JSON.stringify({ ...input, name: 'updated' })}`)).kind).toBe('success')
    expect((await run(`pause ${plan.id}`)).kind).toBe('success')
    expect((await run(`resume ${plan.id}`)).kind).toBe('success')
    expect((await run(`trigger ${plan.id}`)).kind).toBe('success')
    const trigger = (await ctx.scheduler.history())[0]
    if (!trigger) throw new Error('TRIGGER_MISSING')
    expect((await run(`cancel ${trigger.id}`)).kind).toBe('success')
    expect((await run(`history ${plan.id}`)).kind).toBe('success')
    expect((await run(`remove ${plan.id}`)).kind).toBe('success')
    for (const invalid of [
      'bogus',
      'update',
      'pause',
      'create {}',
      'create null',
      'create {',
      'create []',
      'create {"name":42}',
      'create {"name":"t","handler":"t","params":{},"rule":{"kind":"no"}}',
      'create {"name":"t","handler":"t","params":{},"rule":{"kind":"interval","everyMs":"no"}}',
      'create {"name":"t","handler":"t","params":{},"rule":{"kind":"interval","everyMs":1},"misfire":"bad"}',
    ])
      expect((await run(invalid)).kind).toBe('error')
    await fiber.dispose()
    expect(await ctx.commands.execute(agent, '/scheduler list', [], new AbortController().signal)).toBeUndefined()
    await a.dispose()
    await b.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
