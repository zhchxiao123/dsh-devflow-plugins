// The rule the package exists to hold: skip requires a low score AND a
// confident judgement. Every case below that is not exactly that comes back as
// a review, which is what makes "triage skipped something risky" impossible
// rather than unlikely.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { JevError } from '@zhchxiao123/dsh-jev'
import { Config, buildQuestion, buildState, decide, levelNames, triage } from '@zhchxiao123/dsh-jev-triage'
import type { ChangedFile, ResolvedConfig } from '@zhchxiao123/dsh-jev-triage'
import { MemoryJev, scoreAnswer } from './doubles.ts'

const CONFIG = Config({}) as ResolvedConfig
const NAMES = levelNames(CONFIG.scoreLevels)

function file(path: string, chunk = 'diff body', binary = false): ChangedFile {
  return { path, binary, chunk }
}

async function mountJev(): Promise<MemoryJev> {
  const ctx = new Context()
  await ctx.plugin(MemoryJev)
  return ctx.jev as MemoryJev
}

describe('levelNames', () => {
  it('names each level from the text before its first colon', () => {
    expect(NAMES).toEqual(['trivial', 'routine', 'notable', 'risky', 'critical'])
  })

  it('uses the whole level when it carries no colon', () => {
    expect(levelNames(['low', 'high'])).toEqual(['low', 'high'])
  })
})

describe('buildQuestion', () => {
  it('carries the file and its own diff inside the question, not the shared state', () => {
    const question = buildQuestion(file('src/a.ts', 'the diff'), CONFIG).question
    expect(question).toMatchObject({ type: 'score', instructions: { file: 'src/a.ts', diff: 'the diff' } })
    expect(JSON.stringify(buildState('/repo'))).not.toContain('the diff')
  })

  it('truncates a diff past the per-file budget and says so', () => {
    const built = buildQuestion(file('big.ts', 'x'.repeat(50)), { ...CONFIG, maxFileChars: 10 })
    const instructions = built.question.instructions as { diff: string }
    expect(instructions.diff).toBe(`${'x'.repeat(10)}\n... (truncated)`)
  })
})

describe('decide', () => {
  it('skips only a low score with confidence at or above the floor', () => {
    expect(decide(file('a.ts'), scoreAnswer(1, 0.9), CONFIG, NAMES)).toMatchObject({ action: 'skip', level: 'routine' })
  })

  it('reviews a score at the line, not below it', () => {
    expect(decide(file('a.ts'), scoreAnswer(2, 0.9), CONFIG, NAMES)).toMatchObject({ action: 'review' })
  })

  it('skips at exactly the confidence floor and reviews just under it', () => {
    expect(decide(file('a.ts'), scoreAnswer(0, CONFIG.confidenceFloor), CONFIG, NAMES)).toMatchObject({ action: 'skip' })
    const under = decide(file('a.ts'), scoreAnswer(0, CONFIG.confidenceFloor - 0.01), CONFIG, NAMES)
    expect(under).toMatchObject({ action: 'review', reason: `confidence below ${String(CONFIG.confidenceFloor)}` })
  })

  it('reports low confidence rather than the score it did not trust', () => {
    const verdict = decide(file('a.ts'), scoreAnswer(4, 0.1), CONFIG, NAMES)
    expect(verdict.reason).toContain('confidence below')
  })

  it.each([
    ['no answer', undefined, 'no answer came back'],
    ['an answer of the wrong kind', { type: 'noul' }, 'not a score'],
    ['a score with no confidence', { type: 'score', score: 1 }, 'not a score'],
    ['a score with no score', { type: 'score', confidence: 1 }, 'not a score'],
  ])('reviews on %s', (_label, answer, reason) => {
    const verdict = decide(file('a.ts'), answer, CONFIG, NAMES)
    expect(verdict.action).toBe('review')
    expect(verdict.reason).toContain(reason)
  })

  it('reports the score with no level name when the rubric supplies none', () => {
    const verdict = decide(file('a.ts'), scoreAnswer(1, 0.9), CONFIG, [])
    expect(verdict.score).toBe(1)
    expect('level' in verdict).toBe(false)
  })

  it('names the nearest level for a score between two of them, and clamps outside the rubric', () => {
    expect(decide(file('a.ts'), scoreAnswer(1.4, 0.9), CONFIG, NAMES).level).toBe('routine')
    expect(decide(file('a.ts'), scoreAnswer(99, 0.9), CONFIG, NAMES).level).toBe('critical')
    expect(decide(file('a.ts'), scoreAnswer(-5, 0.9), CONFIG, NAMES).level).toBe('trivial')
  })
})

describe('triage', () => {
  const signal = new AbortController().signal

  it('says so when nothing is tracked as changed, and names what it did not cover', async () => {
    const jev = await mountJev()
    const result = await triage(jev, [], '/repo', CONFIG, signal)
    expect(result).toMatchObject({ available: true, review_count: 0, skip_count: 0 })
    expect(result.note).toContain('Untracked files are not triaged')
    expect(jev.calls).toHaveLength(0)
  })

  it('reviews a binary file without asking about it', async () => {
    const jev = await mountJev()
    const result = await triage(jev, [file('logo.png', '', true)], '/repo', CONFIG, signal)
    expect(result.files[0]).toMatchObject({ action: 'review', reason: 'binary file, nothing to read' })
    expect(jev.calls).toHaveLength(0)
  })

  it('reviews everything past the batch size and notes how many', async () => {
    const jev = await mountJev()
    jev.setScript({ answers: { f0: scoreAnswer(0, 1) } })
    const files = [file('a.ts'), file('b.ts'), file('c.ts')]
    const result = await triage(jev, files, '/repo', { ...CONFIG, maxFiles: 1 }, signal)
    expect(result.files.filter(f => f.reason?.includes('beyond the 1-file batch'))).toHaveLength(2)
    expect(result.note).toContain('2 file(s) past the batch size')
  })

  it('reviews a diff that would not fit the per-call budget rather than asking about it', async () => {
    const jev = await mountJev()
    jev.setScript({ answers: { f0: scoreAnswer(0, 1) } })
    const result = await triage(
      jev,
      [file('small.ts', 'x'.repeat(5)), file('huge.ts', 'y'.repeat(100))],
      '/repo',
      { ...CONFIG, maxTotalChars: 20 },
      signal,
    )
    const huge = result.files.find(f => f.path === 'huge.ts')
    expect(huge?.action).toBe('review')
    expect(huge?.reason).toContain('too large')
    expect(Object.keys((jev.calls[0]?.questions ?? {}))).toEqual(['f0'])
  })

  it('reviews everything it asked about when the judgement fails, naming the code', async () => {
    const jev = await mountJev()
    jev.setScript(new JevError('no key', 'JEV_CREDENTIAL_MISSING'))
    const result = await triage(jev, [file('a.ts'), file('b.ts')], '/repo', CONFIG, signal)
    expect(result.files.every(f => f.action === 'review')).toBe(true)
    expect(result.files[0]?.reason).toContain('JEV_CREDENTIAL_MISSING')
    expect(result.note).toContain('defaults to review')
  })

  it('reviews everything when the judgement threw something that is not a JevError', async () => {
    const jev = await mountJev()
    jev.setScript(new TypeError('boom') as unknown as JevError)
    const result = await triage(jev, [file('a.ts')], '/repo', CONFIG, signal)
    expect(result.files[0]?.action).toBe('review')
    expect(result.files[0]?.reason).toContain('JEV_UNAVAILABLE')
  })

  it('re-raises a withdrawn request instead of reporting conservative verdicts', async () => {
    const jev = await mountJev()
    jev.setScript(new JevError('withdrawn', 'JEV_ABORTED'))
    await expect(triage(jev, [file('a.ts')], '/repo', CONFIG, signal))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_ABORTED' }))
  })

  it('accounts for every file exactly once', async () => {
    const jev = await mountJev()
    jev.setScript({ answers: { f0: scoreAnswer(0, 1), f1: scoreAnswer(4, 1) } })
    const result = await triage(
      jev,
      [file('a.ts'), file('b.ts'), file('logo.png', '', true)],
      '/repo',
      CONFIG,
      signal,
    )
    expect(result.files).toHaveLength(3)
    expect(result.review_count + result.skip_count).toBe(result.files.length)
    expect(result.skip_count).toBe(1)
  })
})
