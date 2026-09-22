// Both presenters run on the live stream and again on a session-log replay, so
// what matters here is that they are projections: same value in, same text out,
// no clock and no service reached.
import { describe, expect, it } from 'vitest'
import { presentationMeta, render } from '@zhchxiao123/dsh-jev-triage'
import type { TriageResult } from '@zhchxiao123/dsh-jev-triage'

const RESULT: TriageResult = {
  available: true,
  files: [
    { path: 'src/a.ts', action: 'skip', score: 0, level: 'trivial', confidence: 0.95, diffChars: 12 },
    { path: 'src/b.ts', action: 'review', score: 3, level: 'risky', confidence: 0.88, diffChars: 40 },
    { path: 'logo.png', action: 'review', reason: 'binary file, nothing to read' },
  ],
  review_count: 2,
  skip_count: 1,
  note: 'One diff was truncated.',
}

describe('render', () => {
  it('leads with the counts, then one line per file', () => {
    const text = render(RESULT)[0]?.text ?? ''
    expect(text).toContain('3 file(s) — 2 to review, 1 skipped')
    expect(text).toContain('SKIP  src/a.ts  score 0 (trivial)  conf 0.95')
    expect(text).toContain('REVIEW  logo.png  [binary file, nothing to read]')
    expect(text).toContain('Note: One diff was truncated.')
  })

  it('prints a score with no level name when the verdict carries none', () => {
    const text = render({
      available: true,
      files: [{ path: 'a.ts', action: 'review', score: 2 }],
      review_count: 1,
      skip_count: 0,
    })[0]?.text ?? ''
    const fileLine = text.split('\n')[1] ?? ''
    expect(fileLine).toBe('REVIEW  a.ts  score 2')
  })

  it('tells the reader to review everything when triage could not run', () => {
    const text = render({ available: false, files: [], review_count: 0, skip_count: 0, note: 'git failed' })[0]?.text ?? ''
    expect(text).toContain('git failed')
    expect(text).toContain('Treat every changed file as needing review.')
  })

  it('names no reason when triage could not run and did not say why', () => {
    const text = render({ available: false, files: [], review_count: 0, skip_count: 0 })[0]?.text ?? ''
    expect(text).toContain('unknown reason')
  })
})

describe('presentationMeta', () => {
  it('records the decision as structure, leaving the prose out', () => {
    expect(presentationMeta(RESULT)).toEqual({
      available: true,
      review: 2,
      skip: 1,
      files: [
        { path: 'src/a.ts', action: 'skip', score: 0, confidence: 0.95 },
        { path: 'src/b.ts', action: 'review', score: 3, confidence: 0.88 },
        { path: 'logo.png', action: 'review' },
      ],
    })
  })
})

describe('presenter purity', () => {
  it('projects the same value to the same output twice', () => {
    expect(render(RESULT)).toEqual(render(RESULT))
    expect(presentationMeta(RESULT)).toEqual(presentationMeta(RESULT))
  })
})
