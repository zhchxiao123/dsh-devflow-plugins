// One routing judgement: what it rates against, and the difference between a
// judgement that could not be made and a dispatch the caller withdrew.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { JevError } from '@zhchxiao123/dsh-jev'
import {
  Config, MAX_PROMPT_CHARS, QUESTION_KEY, assertConfig, buildQuestion, buildState, judge, tierIndexOfScore,
} from '@zhchxiao123/dsh-jev-model-router'
import type { ResolvedConfig } from '@zhchxiao123/dsh-jev-model-router'
import { MemoryJev, TIERS, scoreAnswer } from './doubles.ts'

function resolved(overrides: Record<string, unknown> = {}): ResolvedConfig {
  const config = new Config({ tiers: TIERS, ...overrides })
  assertConfig(config)
  return config
}

/** The seam as a consumer holds it: mounted, never constructed by hand. */
async function seam(): Promise<MemoryJev> {
  const ctx = new Context()
  await ctx.plugin(MemoryJev)
  return ctx.jev as MemoryJev
}

const DELEGATION = { description: 'Find the caller', prompt: 'Locate every call site of foo().' }

describe('the routing question', () => {
  it('rates against the tier descriptions themselves', () => {
    const question = buildQuestion(resolved().tiers)
    expect(question.type).toBe('score')
    expect(question.criteria).toEqual(TIERS.map(tier => tier.when))
  })

  it('carries the delegation as the shared evidence', () => {
    const state = buildState(DELEGATION)
    expect(state.description).toBe('Find the caller')
    expect(state.delegatedPrompt).toBe('Locate every call site of foo().')
    expect(state.delegatingParentRoute).toBeUndefined()
  })

  it('truncates a prompt past the budget and says so', () => {
    const state = buildState({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 50) })
    expect(state.delegatedPrompt).toHaveLength(MAX_PROMPT_CHARS + '\n... (truncated)'.length)
    expect(state.delegatedPrompt.endsWith('... (truncated)')).toBe(true)
  })
})

describe('tierIndexOfScore', () => {
  it('rounds a halfway score up to the stronger tier', () => {
    expect(tierIndexOfScore(1.5, 3)).toBe(2)
  })

  it('stays inside the tier list', () => {
    expect(tierIndexOfScore(-4, 3)).toBe(0)
    expect(tierIndexOfScore(9, 3)).toBe(2)
  })
})

describe('judge', () => {
  it('returns the tier the score lands on', async () => {
    const jev = await seam()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const verdict = await judge(jev, DELEGATION, resolved(), new AbortController().signal)
    expect(verdict).toMatchObject({ kind: 'tier', index: 2, score: 2 })
  })

  it('asks exactly one question, under the key it reads back', async () => {
    const jev = await seam()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(0) } })
    await judge(jev, DELEGATION, resolved(), new AbortController().signal)
    expect(Object.keys(jev.calls[0]?.questions ?? {})).toEqual([QUESTION_KEY])
  })

  it('reports an absent answer as unavailable rather than the bottom tier', async () => {
    const jev = await seam()
    jev.setScript({ answers: {} })
    const verdict = await judge(jev, DELEGATION, resolved(), new AbortController().signal)
    expect(verdict).toEqual({ kind: 'unavailable', reason: 'the judgement returned no answer for the routing question' })
  })

  it('reports an answer of the wrong type as unavailable', async () => {
    const jev = await seam()
    jev.setScript({ answers: { [QUESTION_KEY]: { type: 'noul', noul: 0.9 } } })
    const verdict = await judge(jev, DELEGATION, resolved(), new AbortController().signal)
    expect(verdict).toMatchObject({ kind: 'unavailable' })
    expect((verdict as { reason: string }).reason).toContain('answered with a noul')
  })

  it('reports a non-finite score as unavailable', async () => {
    const jev = await seam()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(Number.NaN) } })
    const verdict = await judge(jev, DELEGATION, resolved(), new AbortController().signal)
    expect(verdict).toMatchObject({ kind: 'unavailable' })
    expect((verdict as { reason: string }).reason).toContain('not a finite number')
  })

  it('reports a missing credential as unavailable, carrying its code', async () => {
    const jev = await seam()
    jev.setScript(new JevError('no key', 'JEV_CREDENTIAL_MISSING'))
    const verdict = await judge(jev, DELEGATION, resolved(), new AbortController().signal)
    expect(verdict).toMatchObject({ kind: 'unavailable' })
    expect((verdict as { reason: string }).reason).toContain('JEV_CREDENTIAL_MISSING')
  })

  it('reports a failure the seam never classified as unavailable too', async () => {
    const jev = await seam()
    jev.setScript(new Error('socket hung up'))
    const verdict = await judge(jev, DELEGATION, resolved(), new AbortController().signal)
    expect(verdict).toMatchObject({ kind: 'unavailable' })
    expect((verdict as { reason: string }).reason).toContain('socket hung up')
  })

  it('treats its OWN deadline as unavailable, not as a withdrawal', async () => {
    const jev = await seam()
    jev.setScript({ stall: true })
    const verdict = await judge(jev, DELEGATION, resolved({ judgeTimeoutMs: 5 }), new AbortController().signal)
    expect(verdict).toMatchObject({ kind: 'unavailable' })
    expect((verdict as { reason: string }).reason).toContain('judgeTimeoutMs')
  })

  it('reports a caller withdrawal as withdrawn, through a real abort signal', async () => {
    const jev = await seam()
    jev.setScript({ stall: true })
    const caller = new AbortController()
    const pending = judge(jev, DELEGATION, resolved({ judgeTimeoutMs: 10_000 }), caller.signal)
    caller.abort(new Error('user interrupted'))
    expect(await pending).toEqual({ kind: 'withdrawn' })
  })

  it('reports an already-withdrawn dispatch without spending a call', async () => {
    const jev = await seam()
    const caller = new AbortController()
    caller.abort(new Error('user interrupted'))
    expect(await judge(jev, DELEGATION, resolved(), caller.signal)).toEqual({ kind: 'withdrawn' })
    expect(jev.calls).toHaveLength(0)
  })
})
