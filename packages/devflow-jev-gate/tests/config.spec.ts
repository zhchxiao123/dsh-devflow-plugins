// Every configuration defect is a boot failure naming the offending edge and
// rule — a gate that can veto moves must not guess at its own policy.
import { describe, expect, it } from 'vitest'
import { assertConfig } from '../src/config.ts'

const WARN = { edge: 'developing->reviewing', kinds: ['implementation-risk'], mode: 'warn', timeoutMs: 5000 }
const ENFORCE = {
  edge: 'testing->done', kinds: ['release-readiness', 'implementation-risk'], mode: 'enforce', timeoutMs: 5000,
  failClosed: false, veto: { releaseBlockedMass: 0.5, riskScore: 3.5, riskConfidence: 0.7 },
}

describe('assertConfig', () => {
  it('accepts a warn edge and an enforce edge with both veto conditions', () => {
    const policies = assertConfig({ edges: [WARN, ENFORCE] })
    expect(policies).toHaveLength(2)
    expect(policies[0]).toEqual({ edge: 'developing->reviewing', kinds: ['implementation-risk'], mode: 'warn', timeoutMs: 5000 })
    expect(policies[1]?.veto).toEqual({ releaseBlockedMass: 0.5, riskScore: 3.5, riskConfidence: 0.7 })
  })

  it.each([
    [undefined, 'config.edges must list at least one guarded edge'],
    [{ edges: [] }, 'config.edges must list at least one guarded edge'],
    [{ edges: [null] }, 'edges[0] must be an object'],
    [{ edges: [{ ...WARN, edge: 7 }] }, 'needs an edge of the form "from->to"'],
    [{ edges: [{ ...WARN, edge: 'developing' }] }, 'expected "from->to"'],
    [{ edges: [{ ...WARN, edge: 'developing->shipping' }] }, 'expected "from->to"'],
    [{ edges: [{ ...WARN, kinds: [] }] }, 'at least one assessment kind'],
    [{ edges: [{ ...WARN, kinds: 'implementation-risk' }] }, 'at least one assessment kind'],
    [{ edges: [{ ...WARN, kinds: ['sentiment'] }] }, 'unknown assessment kind "sentiment"'],
    [{ edges: [{ ...WARN, kinds: ['review-scope', 'review-scope'] }] }, 'repeats an assessment kind'],
    [{ edges: [{ ...WARN, mode: 'audit' }] }, 'needs mode "warn" or "enforce"'],
    [{ edges: [{ ...WARN, timeoutMs: 0 }] }, 'positive finite timeoutMs'],
    [{ edges: [{ ...WARN, timeoutMs: Number.POSITIVE_INFINITY }] }, 'positive finite timeoutMs'],
    [{ edges: [{ ...WARN, failClosed: true }] }, 'failClosed and veto belong to enforce edges only'],
    [{ edges: [{ ...WARN, veto: { riskScore: 3 } }] }, 'failClosed and veto belong to enforce edges only'],
    [{ edges: [{ ...ENFORCE, failClosed: undefined }] }, 'explicit failClosed decision'],
    [{ edges: [{ ...ENFORCE, veto: undefined }] }, 'needs a veto object'],
    [{ edges: [{ ...ENFORCE, veto: {} }] }, 'at least one veto condition'],
    [{ edges: [{ ...ENFORCE, veto: { blockedMass: 0.5 } }] }, 'unknown veto conditions: blockedMass'],
    [{ edges: [{ ...ENFORCE, veto: { releaseBlockedMass: 0 } }] }, 'releaseBlockedMass in (0, 1]'],
    [{ edges: [{ ...ENFORCE, veto: { releaseBlockedMass: 1.2 } }] }, 'releaseBlockedMass in (0, 1]'],
    [{ edges: [{ ...ENFORCE, kinds: ['implementation-risk'], veto: { releaseBlockedMass: 0.5 } }] }, 'does not run the release-readiness assessment'],
    [{ edges: [{ ...ENFORCE, veto: { riskScore: '3' } }] }, 'riskScore in (0, 4]'],
    [{ edges: [{ ...ENFORCE, veto: { riskScore: 4.5 } }] }, 'riskScore in (0, 4]'],
    [{ edges: [{ ...ENFORCE, kinds: ['release-readiness'], veto: { riskScore: 3 } }] }, 'does not run the implementation-risk assessment'],
    [{ edges: [{ ...ENFORCE, veto: { riskConfidence: 0.5 } }] }, 'riskConfidence without veto.riskScore'],
    [{ edges: [{ ...ENFORCE, veto: { riskScore: 3, riskConfidence: 2 } }] }, 'riskConfidence in [0, 1]'],
    [{ edges: [WARN, { ...ENFORCE, edge: WARN.edge, kinds: ['release-readiness'], veto: { releaseBlockedMass: 0.5 } }] }, 'guards developing->reviewing twice'],
  ])('rejects %j', (config, message) => {
    expect(() => assertConfig(config)).toThrow(message)
  })
})
