// The seam's contract. Everything asserted here is something the base class
// guarantees on behalf of every provider, so a provider that got it wrong
// would be wrong quietly: the request never reaches transport when its shape
// is already unanswerable, answers are restricted to what was asked, and an
// unanswered question stays absent rather than arriving as a zero.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { JEV_ERROR_CODES, JevError } from '@zhchxiao123/dsh-jev'
import type { JevRequest, Question } from '@zhchxiao123/dsh-jev'
import { MemoryJev, scoreAnswer } from './memory.ts'

const SCORE: Question = {
  type: 'score',
  instructions: 'How risky is this change?',
  criteria: ['Trivial: no logic.', 'Risky: security-critical.'],
}

async function mount(script?: ConstructorParameters<typeof MemoryJev>[1]): Promise<{
  ctx: Context
  jev: MemoryJev
}> {
  const ctx = new Context()
  await ctx.plugin(MemoryJev, script)
  return { ctx, jev: ctx.jev as MemoryJev }
}

function ask(questions: Record<string, Question>): JevRequest {
  return { state: { note: 'evidence' }, questions }
}

describe('JevRuntime.ask', () => {
  it('registers as ctx.jev and answers through the provider', async () => {
    const { jev } = await mount({ answers: { a: scoreAnswer(1) }, model: 'jev-1.13.0' })
    const response = await jev.ask(ask({ a: SCORE }))
    expect(response.answers.a).toMatchObject({ type: 'score', score: 1 })
    expect(response.model).toBe('jev-1.13.0')
    expect(jev.calls).toHaveLength(1)
  })

  it('drops an answer to a question nobody asked', async () => {
    const { jev } = await mount({ answers: { a: scoreAnswer(0), uninvited: scoreAnswer(4) } })
    const response = await jev.ask(ask({ a: SCORE }))
    expect(Object.keys(response.answers)).toEqual(['a'])
    expect('uninvited' in response.answers).toBe(false)
  })

  it('leaves an unanswered question absent rather than zero-filled', async () => {
    const { jev } = await mount({ answers: { a: scoreAnswer(0) } })
    const response = await jev.ask(ask({ a: SCORE, b: SCORE }))
    // The distinction this protects: `b` was not judged, which is not the same
    // fact as `b` having been judged at the bottom of the rubric.
    expect('b' in response.answers).toBe(false)
    expect(response.answers.a).toMatchObject({ score: 0 })
  })

  it('carries usage through untouched', async () => {
    const { jev } = await mount({ answers: {}, usage: { inputTokens: 1234 } })
    const response = await jev.ask(ask({ a: SCORE }))
    expect(response.usage).toEqual({ inputTokens: 1234 })
  })
})

describe('JevRuntime.ask request validation', () => {
  it.each([
    ['a non-object request', null as unknown as JevRequest],
    ['absent questions', { state: 's' } as unknown as JevRequest],
    ['an empty question set', { state: 's', questions: {} }],
    ['a non-object question', { state: 's', questions: { a: 'nope' } } as unknown as JevRequest],
    ['an unknown question type', { state: 's', questions: { a: { type: 'guess', instructions: 'x' } } } as unknown as JevRequest],
    ['a score question with no levels', { state: 's', questions: { a: { type: 'score', instructions: 'x', criteria: [] } } }],
    ['a score question with only one level', { state: 's', questions: { a: { type: 'score', instructions: 'x', criteria: ['only'] } } }],
    ['a choice question with array criteria', { state: 's', questions: { a: { type: 'choice', instructions: 'x', criteria: [] } } }],
    ['a choice question with no options', { state: 's', questions: { a: { type: 'choice', instructions: 'x', criteria: {} } } }],
  ])('rejects %s without reaching the provider', async (_label, request) => {
    const { jev } = await mount()
    await expect(jev.ask(request)).rejects.toThrow(
      expect.objectContaining({ code: 'JEV_INVALID_REQUEST' }),
    )
    expect(jev.calls).toHaveLength(0)
  })

  it('rejects a choice offering more than 255 options', async () => {
    const { jev } = await mount()
    const criteria: Record<string, null> = {}
    for (let i = 0; i < 256; i += 1) criteria[`opt${String(i)}`] = null
    await expect(jev.ask(ask({ a: { type: 'choice', instructions: 'pick', criteria } })))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_INVALID_REQUEST' }))
    expect(jev.calls).toHaveLength(0)
  })

  it('accepts a choice at exactly 255 options and a noul with no criteria', async () => {
    const { jev } = await mount()
    const criteria: Record<string, null> = {}
    for (let i = 0; i < 255; i += 1) criteria[`opt${String(i)}`] = null
    await expect(jev.ask(ask({
      a: { type: 'choice', instructions: 'pick', criteria },
      b: { type: 'noul', instructions: 'is it urgent?' },
    }))).resolves.toBeTruthy()
    expect(jev.calls).toHaveLength(1)
  })
})

describe('JevRuntime.ask cancellation', () => {
  it('raises JEV_ABORTED for an already-withdrawn request, before the provider', async () => {
    const { jev } = await mount()
    await expect(jev.ask(ask({ a: SCORE }), AbortSignal.abort()))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_ABORTED' }))
    expect(jev.calls).toHaveLength(0)
  })

  it('passes a live signal down to the provider', async () => {
    const ctx = new Context()
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    class SignalProbe extends MemoryJev {
      protected override async perform(request: JevRequest, signal?: AbortSignal): Promise<never> {
        seen = signal
        return await super.perform(request) as never
      }
    }
    await ctx.plugin(SignalProbe, { answers: {} })
    await (ctx.jev as SignalProbe).ask(ask({ a: SCORE }), controller.signal)
    expect(seen).toBe(controller.signal)
  })
})

describe('JevError', () => {
  it('carries each code and stays an Error', () => {
    for (const code of JEV_ERROR_CODES) {
      const error = new JevError('boom', code, { cause: new Error('under') })
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(JevError)
      expect(error.code).toBe(code)
      expect(error.name).toBe('JevError')
      expect(error.cause).toBeInstanceOf(Error)
    }
  })
})

describe('JevRuntime disposal', () => {
  it('releases ctx.jev with the fiber that provided it', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryJev, { answers: {} })
    expect(ctx.get('jev')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('jev')).toBeUndefined()
  })
})
