// The module's one rule, exercised branch by branch: a judgement can only
// lose its voice, never gain a veto it was not granted.
import { describe, expect, it, vi } from 'vitest'
import type { TransitionAttempt, TransitionDecision } from '@zhchxiao123/dsh-devflow'
import type { EvaluationRecord } from '@zhchxiao123/dsh-devflow-jev'
import type { Answer } from '@zhchxiao123/dsh-jev'
import { fence, firstVeto, judge, summarize } from '../src/gate.ts'
import type { Assess, Judgement } from '../src/gate.ts'
import type { EdgePolicy } from '../src/types.ts'

const ATTEMPT = { id: '0001-card', root: '/devflow', from: 'developing', to: 'reviewing', at: 't', expectedRevision: 4 } as TransitionAttempt

function record(answers: Record<string, Answer>, status: EvaluationRecord['status'] = 'review', error?: { code: string; message: string }): EvaluationRecord {
  return {
    id: 'eval-1', root: '/devflow', subject: { kind: 'card', cardId: '0001-card', title: 'Card' }, assessmentKind: 'implementation-risk',
    rubricVersion: '3', status, decision: status === 'unavailable' ? 'unavailable' : 'manual-review', confidence: 0.5, answers,
    reasons: [], missingInformation: [], recommendedServiceClass: 'standard', ...error === undefined ? {} : { error }, createdAt: 't',
  } as EvaluationRecord
}

function warnPolicy(overrides: Partial<EdgePolicy> = {}): EdgePolicy {
  return { edge: 'developing->reviewing', kinds: ['implementation-risk'], mode: 'warn', timeoutMs: 200, ...overrides }
}

function enforcePolicy(overrides: Partial<EdgePolicy> = {}): EdgePolicy {
  return {
    edge: 'testing->done', kinds: ['release-readiness', 'implementation-risk'], mode: 'enforce', timeoutMs: 200,
    failClosed: false, veto: { releaseBlockedMass: 0.5, riskScore: 3.5, riskConfidence: 0.7 }, ...overrides,
  }
}

describe('judge', () => {
  it('returns one record per configured kind, in configuration order', async () => {
    const assess: Assess = (_root, _id, kind) => Promise.resolve(record({}, kind === 'release-readiness' ? 'review' : 'unavailable'))
    const judgements = await judge(assess, ATTEMPT, enforcePolicy())
    expect(judgements.map(judgement => judgement.kind)).toEqual(['release-readiness', 'implementation-risk'])
    expect(judgements[0]?.record?.status).toBe('review')
    expect(judgements[1]?.record?.status).toBe('unavailable')
  })

  it('turns a judgement that outlives its deadline into a failure entry', async () => {
    const assess: Assess = (_root, _id, _kind, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    })
    const [judgement] = await judge(assess, ATTEMPT, warnPolicy({ timeoutMs: 10 }))
    expect(judgement).toMatchObject({ kind: 'implementation-risk', failure: 'timed out after 10ms' })
  })

  it.each([
    [new Error('credential missing'), 'credential missing'],
    ['broken provider', 'broken provider'],
  ])('keeps a thrown %o as the failure reason', async (thrown, failure) => {
    // A provider may throw anything; the string case proves the non-Error branch.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    const assess: Assess = () => Promise.reject(thrown)
    const [judgement] = await judge(assess, ATTEMPT, warnPolicy())
    expect(judgement?.failure).toBe(failure)
  })
})

describe('summarize', () => {
  it('renders every answer type and names the evaluation id', () => {
    const line = summarize({ kind: 'implementation-risk', record: record({
      changeRisk: { type: 'score', score: 3.75, probabilities: [0, 0, 0, 0.25, 0.75], confidence: 0.9 },
      releaseDecision: { type: 'choice', choice: 'ready', probabilities: { ready: 0.8, blocked: 0.2 }, confidence: 0.7 },
      irreversible: { type: 'noul', noul: 0.12 },
    }) })
    expect(line).toBe('jev implementation-risk [eval-1]: changeRisk=3.75(c0.90) releaseDecision=ready@0.80 irreversible=0.12')
  })

  it('says so when a judgement carried no answers', () => {
    expect(summarize({ kind: 'intake', record: record({}) })).toBe('jev intake [eval-1]: no answers')
  })

  it('renders a choice whose probabilities omit the chosen option as probability zero', () => {
    const line = summarize({ kind: 'intake', record: record({ releaseDecision: { type: 'choice', choice: 'ready', probabilities: {}, confidence: 0.2 } }) })
    expect(line).toContain('releaseDecision=ready@0.00')
  })

  it.each([
    [{ kind: 'intake', record: record({}, 'unavailable', { code: 'JEV_UNAVAILABLE', message: 'down' }) }, 'jev intake: unavailable (JEV_UNAVAILABLE)'],
    [{ kind: 'intake', record: record({}, 'unavailable') }, 'jev intake: unavailable (unknown)'],
    [{ kind: 'intake', failure: 'timed out after 10ms' }, 'jev intake: unavailable (timed out after 10ms)'],
    [{ kind: 'intake' }, 'jev intake: unavailable (no judgement)'],
  ])('renders the unavailable shape %#', (judgement, line) => {
    expect(summarize(judgement)).toBe(line)
  })

  it('refuses an answer shape the seam does not admit', () => {
    const bogus = record({ mystery: { type: 'verdict' } as unknown as Answer })
    expect(() => summarize({ kind: 'intake', record: bogus })).toThrow('Unsupported answer')
  })
})

describe('firstVeto', () => {
  const ready: Answer = { type: 'choice', choice: 'ready', probabilities: { ready: 0.9, blocked: 0.05, unavailable: 0.05 }, confidence: 0.9 }
  const wavering: Answer = { type: 'choice', choice: 'ready', probabilities: { ready: 0.4, blocked: 0.35, unavailable: 0.25 }, confidence: 0.3 }

  it('lets a clean release and a calm risk through', () => {
    expect(firstVeto(enforcePolicy(), [
      { kind: 'release-readiness', record: record({ releaseDecision: ready }) },
      { kind: 'implementation-risk', record: record({ changeRisk: { type: 'score', score: 1.2, probabilities: [0, 0.8, 0.2, 0, 0], confidence: 0.9 } }) },
    ])).toBeUndefined()
  })

  it('vetoes on blocked probability mass, naming the numbers and the evaluation', () => {
    const reason = firstVeto(enforcePolicy(), [{ kind: 'release-readiness', record: record({ releaseDecision: wavering }) }])
    expect(reason).toBe('jev release judgement wavers: P(blocked)+P(unavailable)=0.60 ≥ 0.50 (evaluation eval-1)')
  })

  it('vetoes on a confident high risk score, and never on an unsure one', () => {
    const confident = record({ changeRisk: { type: 'score', score: 3.8, probabilities: [0, 0, 0, 0.2, 0.8], confidence: 0.95 } })
    const unsure = record({ changeRisk: { type: 'score', score: 3.8, probabilities: [0.2, 0.15, 0.15, 0.2, 0.3], confidence: 0.3 } })
    expect(firstVeto(enforcePolicy(), [{ kind: 'implementation-risk', record: confident }]))
      .toBe('jev implementation risk 3.80 at confidence 0.95 ≥ 3.50 (evaluation eval-1)')
    expect(firstVeto(enforcePolicy(), [{ kind: 'implementation-risk', record: unsure }])).toBeUndefined()
  })

  it('applies the risk condition without a confidence floor when none is configured', () => {
    const policy = enforcePolicy({ veto: { riskScore: 3.5 }, kinds: ['implementation-risk'] })
    const unsure = record({ changeRisk: { type: 'score', score: 3.8, probabilities: [0.2, 0.15, 0.15, 0.2, 0.3], confidence: 0.3 } })
    expect(firstVeto(policy, [{ kind: 'implementation-risk', record: unsure }])).toContain('jev implementation risk 3.80')
  })

  it('treats an unavailable judgement by the edge\'s failClosed choice', () => {
    const unavailable: Judgement[] = [{ kind: 'release-readiness', record: record({}, 'unavailable') }, { kind: 'implementation-risk', failure: 'timed out after 200ms' }]
    expect(firstVeto(enforcePolicy(), unavailable)).toBeUndefined()
    expect(firstVeto(enforcePolicy({ failClosed: true }), unavailable))
      .toBe('jev release-readiness judgement is unavailable and this edge fails closed')
  })

  it('treats a missing expected answer as unavailable under failClosed', () => {
    const empty = [{ kind: 'release-readiness' as const, record: record({}) }, { kind: 'implementation-risk' as const, record: record({}) }]
    expect(firstVeto(enforcePolicy(), empty)).toBeUndefined()
    expect(firstVeto(enforcePolicy({ failClosed: true }), empty)).toBe('jev release-readiness left releaseDecision unanswered and this edge fails closed')
    expect(firstVeto(enforcePolicy({ failClosed: true, veto: { riskScore: 3.5 } }), [empty[1]!]))
      .toBe('jev implementation-risk left changeRisk unanswered and this edge fails closed')
  })

  it('reads a condition only from the assessment kind that answers it', () => {
    // A wavering releaseDecision inside another kind's record must not trip the release condition.
    expect(firstVeto(enforcePolicy(), [{ kind: 'implementation-risk', record: record({ releaseDecision: wavering }) }])).toBeUndefined()
  })

  it('vetoes nothing when a policy carries no conditions', () => {
    const bare = { ...enforcePolicy(), veto: undefined }
    expect(firstVeto(bare, [{ kind: 'release-readiness', record: record({ releaseDecision: wavering }) }])).toBeUndefined()
  })
})

describe('fence', () => {
  const allowed: TransitionDecision = { allowed: true, approvedBy: { kind: 'human', name: 'byclaw' }, checks: [{ by: { kind: 'command', name: 'other-gate' }, verdict: 'allowed', summary: 'prior' }] }

  it('delegates an unconfigured edge untouched, without judging', async () => {
    const assess = vi.fn<Assess>()
    const listener = fence([warnPolicy()], assess)
    const decision = await listener({ ...ATTEMPT, to: 'testing' }, () => Promise.resolve(allowed))
    expect(decision).toBe(allowed)
    expect(assess).not.toHaveBeenCalled()
  })

  it('spends no judgement on a move another policy already vetoed', async () => {
    const assess = vi.fn<Assess>()
    const listener = fence([warnPolicy()], assess)
    const veto: TransitionDecision = { allowed: false, reason: 'someone else said no' }
    expect(await listener(ATTEMPT, () => Promise.resolve(veto))).toBe(veto)
    expect(assess).not.toHaveBeenCalled()
  })

  it('appends warn checks to the landing decision, keeping earlier gates\' checks and signature', async () => {
    const assess: Assess = () => Promise.resolve(record({ irreversible: { type: 'noul', noul: 0.1 } }))
    const listener = fence([warnPolicy()], assess)
    const decision = await listener(ATTEMPT, () => Promise.resolve(allowed))
    expect(decision).toMatchObject({ allowed: true, approvedBy: { kind: 'human', name: 'byclaw' } })
    if (!decision.allowed) throw new Error('expected the move to land')
    expect(decision.checks?.map(check => check.summary)).toEqual(['prior', 'jev implementation-risk [eval-1]: irreversible=0.10'])
    expect(decision.checks?.[1]?.by).toEqual({ kind: 'command', name: 'devflow-jev-gate' })
  })

  it('lets a warn edge pass even when every judgement failed', async () => {
    const assess: Assess = () => Promise.reject(new Error('provider down'))
    const listener = fence([warnPolicy()], assess)
    const decision = await listener(ATTEMPT, () => Promise.resolve({ allowed: true }))
    if (!decision.allowed) throw new Error('expected the move to land')
    expect(decision.checks?.[0]?.summary).toBe('jev implementation-risk: unavailable (provider down)')
  })

  it('vetoes an enforce edge on a configured condition and records checks when it passes', async () => {
    const wavering: Answer = { type: 'choice', choice: 'ready', probabilities: { ready: 0.4, blocked: 0.35, unavailable: 0.25 }, confidence: 0.3 }
    let release: Answer = wavering
    const assess: Assess = (_root, _id, kind) => Promise.resolve(
      kind === 'release-readiness'
        ? record({ releaseDecision: release })
        : record({ changeRisk: { type: 'score', score: 1, probabilities: [0, 1, 0, 0, 0], confidence: 0.9 } }),
    )
    const listener = fence([enforcePolicy({ edge: 'developing->reviewing' })], assess)

    const vetoed = await listener(ATTEMPT, () => Promise.resolve({ allowed: true }))
    expect(vetoed).toEqual({ allowed: false, reason: 'jev release judgement wavers: P(blocked)+P(unavailable)=0.60 ≥ 0.50 (evaluation eval-1)' })

    release = { type: 'choice', choice: 'ready', probabilities: { ready: 0.95, blocked: 0.05 }, confidence: 0.9 }
    const landed = await listener(ATTEMPT, () => Promise.resolve({ allowed: true }))
    if (!landed.allowed) throw new Error('expected the move to land')
    expect(landed.checks).toHaveLength(2)
  })
})
