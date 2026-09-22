// The translation layer on its own. These are the shapes the service actually
// sends and the answers it actually accepts, so they are worth pinning apart
// from any transport: a decoder that quietly accepts the wrong shape is how a
// judgement nobody made turns into a number somebody thresholds.
import { describe, expect, it } from 'vitest'
import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
} from '@typesafe-ai/sdk'
import { JevError } from '@zhchxiao123/dsh-jev'
import type { Question } from '@zhchxiao123/dsh-jev'
import { classify, decodeAnswer, decodeUsage, encodeQuestions, encodeState } from '@zhchxiao123/dsh-jev-typesafe'

const SCORE: Question = { type: 'score', instructions: 'how risky', criteria: ['a', 'b', 'c'] }
const CHOICE: Question = { type: 'choice', instructions: 'which', criteria: { x: null, y: null } }
const NOUL: Question = { type: 'noul', instructions: 'is it' }

describe('encodeState / encodeQuestions', () => {
  it('passes text, structure, and nothing through unchanged', () => {
    expect(encodeState('plain')).toBe('plain')
    expect(encodeState({ a: 1 })).toEqual({ a: 1 })
    expect(encodeState([1, 2])).toEqual([1, 2])
    expect(encodeState(null)).toBeNull()
  })

  it('passes questions through unchanged', () => {
    expect(encodeQuestions({ a: SCORE, b: CHOICE, c: NOUL }))
      .toEqual({ a: SCORE, b: CHOICE, c: NOUL })
  })
})

describe('decodeAnswer', () => {
  it('reads a score, indexing its distribution by level', () => {
    expect(decodeAnswer(SCORE, { type: 'score', score: 1.5, confidence: 0.8, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 } }))
      .toEqual({ type: 'score', score: 1.5, confidence: 0.8, probabilities: [0.2, 0.5, 0.3] })
  })

  it('reads an absent level as no weight, and a non-numeric one the same way', () => {
    expect(decodeAnswer(SCORE, { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1, 2: 'x' } }))
      .toMatchObject({ probabilities: [1, 0, 0] })
  })

  it('reads a score with no distribution at all', () => {
    expect(decodeAnswer(SCORE, { type: 'score', score: 0, confidence: 1 }))
      .toMatchObject({ probabilities: [0, 0, 0] })
  })

  it('reads a choice, dropping non-numeric label weights', () => {
    expect(decodeAnswer(CHOICE, { type: 'choice', choice: 'x', confidence: 0.6, probabilities: { x: 0.6, y: 'nope' } }))
      .toEqual({ type: 'choice', choice: 'x', confidence: 0.6, probabilities: { x: 0.6 } })
  })

  it('reads a choice with no distribution at all', () => {
    expect(decodeAnswer(CHOICE, { type: 'choice', choice: 'x', confidence: 0.6 }))
      .toMatchObject({ probabilities: {} })
  })

  it('reads a noul', () => {
    expect(decodeAnswer(NOUL, { type: 'noul', noul: 0.25 })).toEqual({ type: 'noul', noul: 0.25 })
  })

  it.each([
    ['nothing at all', SCORE, undefined],
    ['null', SCORE, null],
    ['a primitive', SCORE, 7],
    ['a score with no score', SCORE, { type: 'score', confidence: 0.5 }],
    ['a score with an infinite score', SCORE, { type: 'score', score: Infinity, confidence: 0.5 }],
    ['a score with no confidence', SCORE, { type: 'score', score: 1 }],
    ['a score with a non-numeric confidence', SCORE, { type: 'score', score: 1, confidence: 'high' }],
    ['a choice with no label', CHOICE, { type: 'choice', confidence: 0.5 }],
    ['a choice with a non-string label', CHOICE, { type: 'choice', choice: 3, confidence: 0.5 }],
    ['a noul with no probability', NOUL, { type: 'noul' }],
    ['a noul with a NaN probability', NOUL, { type: 'noul', noul: Number.NaN }],
  ])('returns nothing for %s', (_label, question, raw) => {
    expect(decodeAnswer(question, raw)).toBeUndefined()
  })
})

describe('decodeUsage', () => {
  it('restates both counts in the seam vocabulary', () => {
    expect(decodeUsage({ input_tokens: 10, output_tokens: 0 })).toEqual({ inputTokens: 10, outputTokens: 0 })
  })

  it('keeps whichever count is present', () => {
    expect(decodeUsage({ input_tokens: 10 })).toEqual({ inputTokens: 10 })
    expect(decodeUsage({ output_tokens: 4 })).toEqual({ outputTokens: 4 })
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a primitive', 3],
    ['an object with no counts', {}],
    ['an object with non-numeric counts', { input_tokens: 'lots', output_tokens: null }],
  ])('returns nothing for %s', (_label, raw) => {
    expect(decodeUsage(raw)).toBeUndefined()
  })
})

describe('classify', () => {
  it('passes a seam failure through rather than re-wrapping it', () => {
    const original = new JevError('already classified', 'JEV_CREDENTIAL_MISSING')
    expect(classify(original)).toBe(original)
  })

  it.each([
    ['a withdrawn request', new APIUserAbortError(), 'JEV_ABORTED'],
    ['a deadline', new APITimeoutError(20_000), 'JEV_TIMEOUT'],
    ['a rate refusal', APIError.fromResponse(429, {}, new Headers()) as RateLimitError, 'JEV_RATE_LIMITED'],
    ['a rejected key', APIError.fromResponse(401, {}, new Headers()), 'JEV_HTTP_ERROR'],
    ['a server failure', APIError.fromResponse(503, {}, new Headers()), 'JEV_HTTP_ERROR'],
    ['a delivery failure', new TypeError('fetch failed'), 'JEV_UNAVAILABLE'],
    ['a thrown non-error', 'something odd', 'JEV_UNAVAILABLE'],
  ])('maps %s to %s', (_label, error, code) => {
    const classified = classify(error)
    expect(classified).toBeInstanceOf(JevError)
    expect(classified.code).toBe(code)
  })
})
