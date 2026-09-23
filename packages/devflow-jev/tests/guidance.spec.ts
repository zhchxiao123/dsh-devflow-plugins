/* oxlint-disable @stylistic/max-len */
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevResponse } from '@zhchxiao123/dsh-jev'
import { registerGuidance as genericGuidance } from '../../jev/src/guidance.ts'
import { registerGuidance as devflowGuidance } from '../src/guidance.ts'
import { emptyInbox } from '../../../tests/agent-double.ts'

class Provider extends JevRuntime {
  protected perform(): Promise<JevResponse> { return Promise.resolve({ answers: {} }) }
}
const cleanups: Context[] = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.fiber.dispose() })
function owner(ctx: Context, name: string, cwd?: string): Agent {
  const id = SessionId(name)
  const session = Session.create(id, undefined, cwd === undefined ? undefined : { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false })
  let scoped = ctx
  const agent: Agent = { id, session, get ctx() { return scoped }, options: {}, inbox: emptyInbox(), status: 'idle', followup() {}, steer() {}, inject() {}, send() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  scoped = createScope(ctx, agent).ctx
  return agent
}
async function text(ctx: Context, name: string, agent?: Agent) {
  return renderContextSections(await ctx.systemPrompt.assemble(agent === undefined ? {} : assembleContextFor(agent))).find(section => section.name === name)?.text
}
function tool(ctx: Context, name: string) {
  return ctx.tools.register(defineTool({ name, description: 'fixture', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => '' }))
}

for (const [name, required, register] of [['jev-usage', 'jev_run', genericGuidance], ['devflow-jev-usage', 'devflow_assess', devflowGuidance]] as const) {
  describe(name, () => {
    async function boot() {
      const ctx = new Context(); cleanups.push(ctx)
      await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Provider)
      const remove = tool(ctx, required)
      const fiber = ctx.plugin({ inject: ['systemPrompt', 'tools', 'jev'], apply: register }); await fiber
      return { ctx, remove, fiber, agent: owner(ctx, 'owner', '/tmp/jev-guidance-a') }
    }
    it('suppresses unknown configuration, unavailable credentials and lookup errors while delegating assembly', async () => {
      const { ctx, agent } = await boot()
      expect(await ctx.jev.configurationStatus()).toBe('unknown')
      const delegated = vi.fn()
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { delegated(); return next() })
      expect(await text(ctx, name, agent)).toBeUndefined()
      const status = vi.spyOn(ctx.jev, 'configurationStatus').mockResolvedValue('unconfigured')
      expect(await text(ctx, name, agent)).toBeUndefined()
      status.mockRejectedValue(new Error('secret lookup diagnostic'))
      expect(await text(ctx, name, agent)).toBeUndefined()
      expect(delegated).toHaveBeenCalledTimes(3)
    })
    it('includes guidance in the FIRST assembly, observes rotation immediately and removes contributions on disposal', async () => {
      const { ctx, agent, fiber } = await boot()
      const status = vi.spyOn(ctx.jev, 'configurationStatus').mockResolvedValue('configured')
      const other = owner(ctx, 'other', '/tmp/jev-guidance-other')
      const cwdless = owner(ctx, 'bare')
      expect(await text(ctx, name, agent)).toContain('not test results')
      expect(await text(ctx, name, cwdless)).toBeUndefined()
      expect(await text(ctx, name)).toBeUndefined()
      expect(status).toHaveBeenCalledOnce()
      status.mockResolvedValue('unconfigured')
      expect(await text(ctx, name, other)).toBeUndefined()
      expect(await text(ctx, name, agent)).toBeUndefined()
      status.mockResolvedValue('configured')
      expect(await text(ctx, name, agent)).toBeDefined()
      status.mockRejectedValue(new Error('store unavailable'))
      expect(await text(ctx, name, agent)).toBeUndefined()
      status.mockResolvedValue('configured')
      expect(await text(ctx, name, agent)).toBeDefined()
      await fiber.dispose()
      const calls = status.mock.calls.length
      expect(await text(ctx, name, agent)).toBeUndefined()
      expect(status).toHaveBeenCalledTimes(calls)
    })
    it('checks current tool visibility each assembly and avoids credential reads for hidden tools', async () => {
      const { ctx, agent, remove } = await boot()
      const status = vi.spyOn(ctx.jev, 'configurationStatus').mockResolvedValue('configured')
      expect(await text(ctx, name, agent)).toBeDefined()
      const restrict = agent.ctx.get('tools')!.restrict({ deny: [required] })
      expect(await text(ctx, name, agent)).toBeUndefined()
      expect(status).toHaveBeenCalledOnce()
      const other = owner(ctx, 'unrestricted', '/tmp/jev-guidance-other')
      expect(await text(ctx, name, other)).toBeDefined()
      restrict()
      expect(await text(ctx, name, agent)).toBeDefined()
      remove()
      expect(await text(ctx, name, agent)).toBeUndefined()
    })
    it('respects runtime context suppression and the ordered placeholder', async () => {
      const { ctx, agent } = await boot()
      const status = vi.spyOn(ctx.jev, 'configurationStatus').mockResolvedValue('configured')
      ctx.systemPrompt.context({ name: 'before-jev', order: 210, text: 'before' })
      ctx.systemPrompt.context({ name: 'after-jev', order: 240, text: 'after' })
      expect(renderContextSections(await ctx.systemPrompt.assemble(assembleContextFor(agent))).map(section => section.name)).toEqual(['before-jev', name, 'after-jev'])
      const restore = ctx.systemPrompt.suppressRuntimeContext()
      expect(await text(ctx, name, agent)).toBeUndefined()
      expect(status).toHaveBeenCalledOnce()
      restore()
      expect(await text(ctx, name, agent)).toBeDefined()
    })
    it('advertises only currently visible optional capabilities', async () => {
      const { ctx, agent } = await boot()
      vi.spyOn(ctx.jev, 'configurationStatus').mockResolvedValue('configured')
      expect(await text(ctx, name, agent)).not.toContain('Use jev_list')
      const optional = ['jev_list', 'jev_control', 'jev_triage', 'devflow_decide_judgement', ...(required === 'jev_run' ? [] : ['jev_run'])]
      const remove = optional.map(name => tool(ctx, name))
      // Only presence is used by the guidance; run behavior is covered in Loader composition.
      ctx.provide('jevRuns', {})
      ctx.provide('devflowAssistance', {})
      const content = await text(ctx, name, agent)
      expect(content).toContain('Use jev_list')
      if (required === 'jev_run') { expect(content).toContain('tracked changed-file'); expect(content).toContain('Use jev_control') }
      else { expect(content).toContain('Accept creates a card'); expect(content).toContain('source=devflow-audit'); expect(content).toContain('source=devflow-assistance') }
      remove.forEach((dispose) => { dispose() })
      expect(await text(ctx, name, agent)).not.toContain('Use jev_list')
    })
  })
}
