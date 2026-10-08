// The guidance contribution: what the first assembled prompt already says, and
// what it stops saying when the credential goes away.
//
// Every case assembles directly. Nothing here arranges a pre-step before an
// assemble, because the published runtime assembles prompt context before that
// waterfall and a spec that relied on the other order would prove nothing about
// the first model request.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as Router from '@zhchxiao123/dsh-jev-model-router'
import { CONTEXT_NAME, CONTEXT_ORDER, guidanceText } from '@zhchxiao123/dsh-jev-model-router'
import { MemoryJev, TIERS, delegationTool, listModelsTool, testAgent } from './doubles.ts'

interface Booted {
  ctx: Context
  jev: MemoryJev
  agent: Agent
  fork: { dispose: () => Promise<unknown> }
}

async function boot(options: { modelSelection?: boolean } = {}): Promise<Booted> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(MemoryJev)
  ctx.tools.register(delegationTool([]))
  if (options.modelSelection !== false) ctx.tools.register(listModelsTool())
  const fork = await ctx.plugin(Router, { tiers: TIERS })
  return { ctx, jev: ctx.jev as MemoryJev, agent: testAgent(), fork }
}

/** The text this package contributed to one assembly, or undefined. */
async function contributed(ctx: Context, agent: Agent): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble({ agent })
  const entry = assembly.contexts.find(context => context.name === CONTEXT_NAME)
  return entry === undefined || entry.text.length === 0 ? undefined : entry.text
}

describe('routing guidance', () => {
  it('reaches the very first assembly', async () => {
    const { ctx, agent } = await boot()
    const text = await contributed(ctx, agent)
    expect(text).toContain('always set `provider` and `model` explicitly')
    expect(text).toContain('cheap (provider "p", model "small")')
  })

  it('registers under an order that keeps it next to the jev block', () => {
    expect(CONTEXT_ORDER).toBe(221)
  })

  it('promises enforcement only while a credential is configured', async () => {
    const { ctx, jev, agent } = await boot()
    expect(await contributed(ctx, agent)).toContain('refused once with the tier to use')
    jev.setStatus('unconfigured')
    // The table is still right; only the claim that it is checked is not.
    const degraded = await contributed(ctx, agent)
    expect(degraded).toContain('always set `provider` and `model` explicitly')
    expect(degraded).not.toContain('refused once')
  })

  it('drops the enforcement sentence when the credential resolver fails', async () => {
    const { ctx, jev, agent } = await boot()
    jev.setStatusThrows()
    const text = await contributed(ctx, agent)
    expect(text).toContain('always set `provider` and `model` explicitly')
    expect(text).not.toContain('refused once')
  })

  it('stays silent when the agent cannot name a route at all', async () => {
    const { ctx, agent } = await boot({ modelSelection: false })
    expect(await contributed(ctx, agent)).toBeUndefined()
  })

  it('stays silent when there is no agent to check visibility for', async () => {
    const { ctx } = await boot()
    const assembly = await ctx.systemPrompt.assemble({})
    const entry = assembly.contexts.find(context => context.name === CONTEXT_NAME)
    expect(entry?.text).toBe('')
  })

  it('leaves nothing behind once unloaded', async () => {
    const { ctx, agent, fork } = await boot()
    expect(await contributed(ctx, agent)).toBeDefined()
    await fork.dispose()
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.contexts.find(context => context.name === CONTEXT_NAME)).toBeUndefined()
  })
})

describe('guidance text', () => {
  it('names every tier with its route and reasoning effort', () => {
    const text = guidanceText({ tools: ['subagent'], tiers: TIERS as never, judgeTimeoutMs: 1 }, false)
    expect(text).toContain('deep (provider "p", model "large", reasoning_effort "high")')
    expect(text).not.toContain('refused once')
  })

  it('names every governed tool', () => {
    const text = guidanceText({ tools: ['subagent', 'subagent_alt'], tiers: TIERS as never, judgeTimeoutMs: 1 }, true)
    expect(text).toContain('`subagent`, `subagent_alt`')
  })
})
