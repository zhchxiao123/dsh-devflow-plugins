import { describe, expect, it } from 'vitest'
import type { Answer } from '@zhchxiao123/dsh-jev'
import { assessmentRequest, decide, DEFAULT_POLICY } from '../src/rubric.ts'
import type { AssessmentKind } from '../src/types.ts'

const noul = (value: number): Answer => ({ type: 'noul', noul: value })
const score = (value: number, confidence = 0.95): Answer => ({ type: 'score', score: value, confidence, probabilities: [0, 0, 0, 1, 0] })
const choice = (value: string): Answer => ({ type: 'choice', choice: value, confidence: 0.95, probabilities: { [value]: 1 } })
const intake = {
  codeSolvable: noul(0.99), informationSufficient: noul(0.99), value: score(4), risk: score(0),
  scopeClarity: score(4), recommendedAction: choice('create'), serviceClass: choice('emergency'),
}
const stages: Readonly<Record<Exclude<AssessmentKind, 'intake'>, Readonly<Record<string, Answer>>>> = {
  planning: { acceptanceExecutable: noul(0.99), dependencyClarity: score(3) },
  'implementation-risk': { changeRisk: score(1), riskControlled: noul(0.99) },
  'test-impact': { testCoverage: score(3) },
  'review-scope': { reviewBreadth: score(1), scopeAligned: noul(0.99) },
  'release-readiness': { requiredEvidencePresent: noul(0.99), releaseDecision: choice('ready') },
  'spec-delta': { behaviorChanged: noul(0.99), specificationCovered: noul(0.99) },
}

describe('stage-specific assessment decisions', () => {
  for (const [kind, answers] of Object.entries(stages)) {
    const stage = kind as Exclude<AssessmentKind, 'intake'>
    it(`${stage} continues only from its specialized answers`, () => {
      expect(decide(answers, DEFAULT_POLICY, true, stage)).toMatchObject({ decision: 'continue', serviceClass: 'standard' })
      expect(assessmentRequest({}, stage).questions).not.toHaveProperty('codeSolvable')
      expect(assessmentRequest({}, stage).questions).not.toHaveProperty('serviceClass')
    })
    it(`${stage} does not substitute intake answers for missing evidence`, () => {
      expect(decide(intake, DEFAULT_POLICY, true, stage)).toMatchObject({ decision: 'manual-review', confidence: 0 })
      for (const key of Object.keys(answers)) {
        const partial = Object.fromEntries(Object.entries(answers).filter(([name]) => name !== key))
        expect(decide({ ...intake, ...partial }, DEFAULT_POLICY, true, stage)).toMatchObject({ decision: 'manual-review', confidence: 0 })
      }
    })
    it(`${stage} ignores unrelated confidence and service-class answers`, () => {
      expect(decide({ ...intake, ...answers, irrelevant: noul(0.5) }, DEFAULT_POLICY, true, stage))
        .toEqual(decide(answers, DEFAULT_POLICY, true, stage))
    })
  }

  it.each(['blocked', 'conditional', 'unavailable', 'unknown'])('does not turn a %s release into continue with strong intake scores', (posture) => {
    expect(decide({ ...intake, ...stages['release-readiness'], releaseDecision: choice(posture) }, DEFAULT_POLICY, true, 'release-readiness'))
      .toMatchObject({ decision: 'manual-review', serviceClass: 'standard' })
  })
  it.each([
    ['planning', 'acceptanceExecutable', noul(0.01), 'needs-information'],
    ['planning', 'dependencyClarity', score(1), 'needs-information'],
    ['implementation-risk', 'riskControlled', noul(0.01), 'manual-review'],
    ['implementation-risk', 'changeRisk', score(4), 'manual-review'],
    ['test-impact', 'testCoverage', score(1), 'needs-information'],
    ['test-impact', 'testCoverage', score(2), 'needs-information'],
    ['review-scope', 'scopeAligned', noul(0.01), 'manual-review'],
    ['review-scope', 'reviewBreadth', score(4), 'manual-review'],
    ['release-readiness', 'requiredEvidencePresent', noul(0.01), 'needs-information'],
    ['spec-delta', 'specificationCovered', noul(0.01), 'needs-information'],
  ] as const)('%s consumes %s instead of positive intake scores', (kind, key, answer, decision) => {
    expect(decide({ ...intake, ...stages[kind], [key]: answer }, DEFAULT_POLICY, true, kind).decision).toBe(decision)
  })
  it('does not let strong companion answers hide an uncertain stage answer', () => {
    const result = decide({ ...intake, ...stages.planning, dependencyClarity: score(3, 0.3) }, DEFAULT_POLICY, true, 'planning')
    expect(result).toMatchObject({ decision: 'manual-review', confidence: 0.3 })
  })
  it('requests manual review for a stage answer with the wrong type', () => {
    expect(decide({ ...stages.planning, dependencyClarity: noul(0.99) }, DEFAULT_POLICY, true, 'planning'))
      .toMatchObject({ decision: 'manual-review', confidence: 0, missingInformation: ['Missing stage answer: dependencyClarity.'] })
  })
  it('does not demand a new specification for an unchanged contract', () => {
    expect(decide({ behaviorChanged: noul(0.01), specificationCovered: noul(0.01) }, DEFAULT_POLICY, true, 'spec-delta').decision).toBe('continue')
  })
  it('keeps pre-card proposals and intake compatibility without extending the stage authority', () => {
    expect(decide(stages.planning, DEFAULT_POLICY, false, 'planning').decision).toBe('propose')
    expect(decide(intake, DEFAULT_POLICY, false)).toMatchObject({ decision: 'propose', serviceClass: 'emergency' })
    expect(decide(intake, DEFAULT_POLICY, true).decision).toBe('continue')
    expect(decide({ ...intake, irrelevant: noul(0.5) }, DEFAULT_POLICY, true)).toEqual(decide(intake, DEFAULT_POLICY, true))
    expect(assessmentRequest({ task: 'untrusted task', assessmentKind: 'intake' }, 'planning').state)
      .toMatchObject({ task: 'Devflow planning assessment', assessmentKind: 'planning' })
  })
  it('keeps incomplete intake, requests for information, high risk, and unsuitable work conservative', () => {
    expect(decide({}, DEFAULT_POLICY, false)).toMatchObject({ decision: 'manual-review', confidence: 0 })
    expect(decide({ ...intake, informationSufficient: noul(0.01), scopeClarity: score(1) }, DEFAULT_POLICY, false).decision).toBe('needs-information')
    expect(decide({ ...intake, recommendedAction: choice('ask') }, DEFAULT_POLICY, false).decision).toBe('needs-information')
    expect(decide({ ...intake, risk: score(4) }, DEFAULT_POLICY, false).decision).toBe('manual-review')
    expect(decide({ ...intake, codeSolvable: noul(0.5) }, DEFAULT_POLICY, false).decision).toBe('manual-review')
    expect(decide({ ...intake, risk: score(1, 0) }, { ...DEFAULT_POLICY, scoreConfidenceFloor: 0.99 }, false).decision).toBe('manual-review')
    expect(decide({ ...intake, recommendedAction: choice('reject'), codeSolvable: noul(0.01), value: score(0) }, DEFAULT_POLICY, false).decision).toBe('reject')
    expect(decide({ ...intake, serviceClass: choice('express'), recommendedAction: choice('investigate') }, DEFAULT_POLICY, false))
      .toMatchObject({ decision: 'propose', serviceClass: 'express' })
    expect(decide({ ...intake, value: score(1), serviceClass: choice('standard') }, DEFAULT_POLICY, false))
      .toMatchObject({ decision: 'manual-review', serviceClass: 'standard' })
    expect(decide({ ...intake, recommendedAction: choice('unknown') }, DEFAULT_POLICY, false).decision).toBe('manual-review')
    expect(decide({ ...stages['release-readiness'], releaseDecision: noul(0.9) }, DEFAULT_POLICY, true, 'release-readiness').decision).toBe('manual-review')
  })
})
