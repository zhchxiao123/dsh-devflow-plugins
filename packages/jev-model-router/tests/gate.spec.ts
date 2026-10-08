// The correction as a model meets it: a delegation on the wrong tier is
// refused once with the route to use, and everything that is not a
// disagreement gets out of the way.
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JevError } from '@zhchxiao123/dsh-jev'
import * as Router from '@zhchxiao123/dsh-jev-model-router'
import { CorrectionLedger, MAX_REMEMBERED_CORRECTIONS, QUESTION_KEY, correction } from '@zhchxiao123/dsh-jev-model-router'
import {
  MemoryJev, TIERS, delegationTool, listModelsTool, scoreAnswer, testAgent,
} from './doubles.ts'
import type { DelegationCall } from './doubles.ts'

interface Booted {
  ctx: Context
  jev: MemoryJev
  calls: DelegationCall[]
  warnings: string[]
}

async function boot(options: {
  config?: Record<string, unknown>
  modelSelection?: boolean
  extraTool?: string
} = {}): Promise<Booted> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(MemoryJev)
  const calls: DelegationCall[] = []
  ctx.tools.register(delegationTool(calls))
  if (options.extraTool !== undefined) ctx.tools.register(delegationTool(calls, options.extraTool))
  if (options.modelSelection !== false) ctx.tools.register(listModelsTool())
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
  await ctx.plugin(Router, { tiers: TIERS, ...options.config })
  return { ctx, jev: ctx.jev as MemoryJev, calls, warnings }
}

let sequence = 0
function dispatch(
  ctx: Context,
  agent: Agent,
  args: Record<string, unknown>,
  name = 'subagent',
  signal = new AbortController().signal,
) {
  return ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(`delegate-${String(++sequence)}`),
    signal,
    agent,
  })
}

/** The text a denied call shows the model. */
function text(result: { content: { type: string }[] }): string {
  return result.content.map(block => ('text' in block ? String(block.text) : '')).join('\n')
}

const WORK = { description: 'Design the cache', prompt: 'Design a write-through cache for the session store.' }

describe('the routing correction', () => {
  it('refuses a delegation whose route disagrees with the judgement', async () => {
    const { ctx, jev, calls } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const result = await dispatch(ctx, testAgent(), { ...WORK, provider: 'p', model: 'small' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('"deep" model tier')
    expect(text(result)).toContain('model "large"')
    expect(text(result)).toContain('reasoning_effort "high"')
    // Refused means not run: the body never saw this delegation.
    expect(calls).toHaveLength(0)
  })

  it('allows a delegation already on the judged tier', async () => {
    const { ctx, jev, calls } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(0) } })
    const result = await dispatch(ctx, testAgent(), { ...WORK, provider: 'p', model: 'small' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
  })

  it('refuses a delegation that named no route at all', async () => {
    const { ctx, jev } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(1) } })
    const result = await dispatch(ctx, testAgent(), WORK)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('"standard" model tier')
  })

  it('refuses an off-table route', async () => {
    const { ctx, jev } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(1) } })
    const result = await dispatch(ctx, testAgent(), { ...WORK, provider: 'elsewhere', model: 'unknown' })
    expect(result.isError).toBe(true)
  })

  it('refuses the same delegation only once, whatever the retry picks', async () => {
    const { ctx, jev, calls } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const agent = testAgent()
    expect((await dispatch(ctx, agent, { ...WORK, provider: 'p', model: 'small' })).isError).toBe(true)
    // Same prompt, same wrong tier: a second refusal would be a dead
    // delegation, so this one goes through.
    const retry = await dispatch(ctx, agent, { ...WORK, provider: 'p', model: 'small' })
    expect(retry.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
  })

  it('still corrects a DIFFERENT delegation from the same agent', async () => {
    const { ctx, jev } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const agent = testAgent()
    await dispatch(ctx, agent, { ...WORK, provider: 'p', model: 'small' })
    const other = await dispatch(ctx, agent, { prompt: 'Rename a local variable.', provider: 'p', model: 'small' })
    expect(other.isError).toBe(true)
  })

  it('carries the delegating parent route into the evidence', async () => {
    const { ctx, jev } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(1) } })
    await dispatch(ctx, testAgent({ provider: 'p', model: 'medium' }), WORK)
    expect(jev.calls[0]?.state).toMatchObject({ delegatingParentRoute: 'p/medium' })
  })
})

describe('what the correction keeps out of the way of', () => {
  it('leaves an ungoverned delegation tool alone', async () => {
    const { ctx, jev, calls } = await boot({ extraTool: 'subagent_fork' })
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const result = await dispatch(ctx, testAgent(), { ...WORK, provider: 'p', model: 'small' }, 'subagent_fork')
    expect(result.isError).toBeFalsy()
    expect(jev.calls).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('stands down with no credential, leaving the model its own pick', async () => {
    const { ctx, jev, calls } = await boot()
    jev.setStatus('unconfigured')
    const result = await dispatch(ctx, testAgent(), { ...WORK, provider: 'p', model: 'small' })
    expect(result.isError).toBeFalsy()
    expect(jev.calls).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('stands down when configuration status is unknown', async () => {
    const { ctx, jev } = await boot()
    jev.setStatus('unknown')
    expect((await dispatch(ctx, testAgent(), WORK)).isError).toBeFalsy()
    expect(jev.calls).toHaveLength(0)
  })

  it('stands down when the credential resolver itself fails', async () => {
    const { ctx, jev } = await boot()
    jev.setStatusThrows()
    expect((await dispatch(ctx, testAgent(), WORK)).isError).toBeFalsy()
    expect(jev.calls).toHaveLength(0)
  })

  it('allows the dispatch when the judgement is unavailable', async () => {
    const { ctx, jev, calls } = await boot()
    jev.setScript(new JevError('no key', 'JEV_CREDENTIAL_MISSING'))
    const result = await dispatch(ctx, testAgent(), { ...WORK, provider: 'p', model: 'small' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
  })

  it('allows the dispatch when its own judgement deadline expires', async () => {
    const { ctx, jev, calls } = await boot({ config: { judgeTimeoutMs: 5 } })
    jev.setScript({ stall: true })
    const result = await dispatch(ctx, testAgent(), { ...WORK, provider: 'p', model: 'small' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
  })

  it('does not judge a call whose prompt is not usable text', async () => {
    const { ctx, jev } = await boot()
    await dispatch(ctx, testAgent(), { description: 'no prompt' })
    expect(jev.calls).toHaveLength(0)
  })

  it('leaves a call with no delegating agent alone', async () => {
    const { ctx, jev, calls } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const result = await ctx.tools.execute({
      name: 'subagent',
      arguments: { ...WORK, provider: 'p', model: 'small' },
      callId: ToolCallId('delegate-agentless'),
      signal: new AbortController().signal,
    })
    expect(result.isError).toBeFalsy()
    expect(jev.calls).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })
})

describe('readArguments', () => {
  it('reads nothing out of something that is not an object', () => {
    expect(Router.readArguments(null)).toEqual({})
    expect(Router.readArguments('a string')).toEqual({})
  })

  it('drops a field of the wrong type rather than passing it on', () => {
    expect(Router.readArguments({ prompt: 7, model: '', provider: 'p' })).toEqual({ provider: 'p' })
  })
})

describe('an inert router', () => {
  it('says so once when no route can be named at all', async () => {
    const { ctx, jev, warnings, calls } = await boot({ modelSelection: false })
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const agent = testAgent()
    await dispatch(ctx, agent, { ...WORK, provider: 'p', model: 'small' })
    await dispatch(ctx, agent, { ...WORK, provider: 'p', model: 'small' })
    expect(calls).toHaveLength(2)
    expect(jev.calls).toHaveLength(0)
    const inert = warnings.filter(line => line.includes('list_subagent_models'))
    expect(inert).toHaveLength(1)
    expect(inert[0]).toContain('modelSelectionSettings')
  })

  it('is inert the same way with no credential either', async () => {
    const { ctx, jev, warnings, calls } = await boot({ modelSelection: false })
    jev.setStatus('unconfigured')
    await dispatch(ctx, testAgent(), { ...WORK, provider: 'p', model: 'small' })
    expect(calls).toHaveLength(1)
    expect(jev.calls).toHaveLength(0)
    expect(warnings.filter(line => line.includes('list_subagent_models'))).toHaveLength(1)
  })
})

describe('disposal', () => {
  it('stops observing delegations once unloaded', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(MemoryJev)
    const calls: DelegationCall[] = []
    ctx.tools.register(delegationTool(calls))
    ctx.tools.register(listModelsTool())
    const fork = await ctx.plugin(Router, { tiers: TIERS })
    const jev = ctx.jev as MemoryJev
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const agent = testAgent()
    expect((await dispatch(ctx, agent, { ...WORK, provider: 'p', model: 'small' })).isError).toBe(true)

    await fork.dispose()
    // A fresh prompt, so a pass here is the listener being gone rather than
    // the correction budget being spent.
    const after = await dispatch(ctx, agent, { prompt: 'Something else entirely.', provider: 'p', model: 'small' })
    expect(after.isError).toBeFalsy()
    expect(jev.calls).toHaveLength(1)
  })
})

describe('CorrectionLedger', () => {
  it('reports the first spend as fresh and the second as already spent', () => {
    const ledger = new CorrectionLedger()
    const agent = testAgent()
    expect(ledger.spend(agent, 'a')).toBe(false)
    expect(ledger.spend(agent, 'a')).toBe(true)
  })

  it('keeps agents separate', () => {
    const ledger = new CorrectionLedger()
    expect(ledger.spend(testAgent({}, 'one'), 'a')).toBe(false)
    expect(ledger.spend(testAgent({}, 'two'), 'a')).toBe(false)
  })

  it('drops the oldest entry past the cap instead of growing without bound', () => {
    const ledger = new CorrectionLedger()
    const agent = testAgent()
    for (let index = 0; index < MAX_REMEMBERED_CORRECTIONS; index += 1) {
      ledger.spend(agent, `d${String(index)}`)
    }
    ledger.spend(agent, 'overflow')
    // The oldest was evicted, so its next correction is fresh again; the most
    // recent entries are still remembered.
    expect(ledger.spend(agent, 'd0')).toBe(false)
    expect(ledger.spend(agent, 'overflow')).toBe(true)
  })
})

describe('correction text', () => {
  it('omits reasoning effort for a tier that wants none', () => {
    const tier = { key: 'cheap', when: 'Mechanical edits.', provider: 'p', model: 'small' }
    const message = correction(tier, 'subagent')
    expect(message).toContain('provider "p" and model "small"')
    expect(message).not.toContain('reasoning_effort')
  })

  it('names the tool to retry on', () => {
    expect(correction({ key: 'k', when: 'w', provider: 'p', model: 'm' }, 'subagent_alt'))
      .toContain('Re-issue the same subagent_alt call')
  })
})

describe('plugin surface', () => {
  it('refuses to mount on a configuration it cannot route with', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(MemoryJev)
    await expect(ctx.plugin(Router, { tiers: [TIERS[0]] }).await()).rejects.toThrow('at least two tiers')
  })
})
