// What the schema cannot check. Schemastery leaves object properties optional,
// so every case here is a shape the schema admits and the mount must not.
import { describe, expect, it } from 'vitest'
import { Config, assertConfig, tierIndexOfRoute } from '@zhchxiao123/dsh-jev-model-router'
import { TIERS } from './doubles.ts'

/** Run a candidate through the schema first, exactly as a mount does. */
function check(raw: unknown): () => void {
  return () => { assertConfig(new Config(raw)) }
}

describe('jev-model-router config', () => {
  it('accepts a complete tier list', () => {
    expect(check({ tiers: TIERS })).not.toThrow()
  })

  it('defaults the governed tool to subagent', () => {
    const resolved = new Config({ tiers: TIERS })
    assertConfig(resolved)
    expect(resolved.tools).toEqual(['subagent'])
  })

  it('refuses a config that is not an object', () => {
    expect(() => { assertConfig(null) }).toThrow('config must be an object')
    expect(() => { assertConfig(42) }).toThrow('config must be an object')
  })

  it('refuses an empty tool list', () => {
    expect(check({ tiers: TIERS, tools: [] })).toThrow('must name at least one delegation tool')
  })

  it('refuses a blank tool name', () => {
    expect(check({ tiers: TIERS, tools: [''] })).toThrow('non-empty tool name')
  })

  it('refuses a missing tier list', () => {
    expect(check({})).toThrow('at least two tiers')
  })

  it('refuses a single tier, which has nothing to discriminate', () => {
    expect(check({ tiers: [TIERS[0]] })).toThrow('at least two tiers')
  })

  it('names the index and field of a half-filled tier', () => {
    expect(check({ tiers: [TIERS[0], { key: 'x', provider: 'p', model: 'm' }] }))
      .toThrow('config.tiers[1].when must be a non-empty string')
    expect(check({ tiers: [TIERS[0], { key: 'x', when: 'w', model: 'm' }] }))
      .toThrow('config.tiers[1].provider must be a non-empty string')
  })

  // The schema normalizes a null tier into `{}` before the mount sees it, so
  // these two shapes are checked against the validator directly — which is
  // also why its parameter is `unknown`: what reaches a plugin has whatever
  // shape its caller gave it, and the schema is not the only caller.
  it('refuses a tier that is not an object', () => {
    expect(() => { assertConfig({ tools: ['subagent'], tiers: [TIERS[0], null], judgeTimeoutMs: 1 }) })
      .toThrow('config.tiers[1] must be an object')
  })

  it('refuses a judgeTimeoutMs the schema never had a chance to default', () => {
    expect(() => { assertConfig({ tools: ['subagent'], tiers: TIERS, judgeTimeoutMs: 0 }) })
      .toThrow('positive whole number')
    expect(() => { assertConfig({ tools: ['subagent'], tiers: TIERS, judgeTimeoutMs: 2.5 }) })
      .toThrow('positive whole number')
  })

  it('refuses a blank reasoningEffort while allowing an absent one', () => {
    expect(check({ tiers: [TIERS[0], { ...TIERS[1], reasoningEffort: '' }] }))
      .toThrow('config.tiers[1].reasoningEffort')
    expect(check({ tiers: [TIERS[0], TIERS[1]] })).not.toThrow()
  })

  it('refuses a repeated tier key', () => {
    expect(check({ tiers: [TIERS[0], { ...TIERS[1], key: 'cheap' }] }))
      .toThrow('repeats key "cheap"')
  })

  it('refuses two tiers on one route, which a correction could not distinguish', () => {
    expect(check({ tiers: [TIERS[0], { ...TIERS[1], provider: 'p', model: 'small' }] }))
      .toThrow('repeats route "p/small"')
  })

  it('lets the schema reject a judgeTimeoutMs below one millisecond, naming the field', () => {
    expect(check({ tiers: TIERS, judgeTimeoutMs: 0 })).toThrow('judgeTimeoutMs')
  })
})

describe('tierIndexOfRoute', () => {
  it('finds the tier a route belongs to', () => {
    const resolved = new Config({ tiers: TIERS })
    assertConfig(resolved)
    expect(tierIndexOfRoute(resolved.tiers, 'p', 'small')).toBe(0)
    expect(tierIndexOfRoute(resolved.tiers, 'p', 'large')).toBe(2)
  })

  it('reports an absent or off-table route as no tier', () => {
    const resolved = new Config({ tiers: TIERS })
    assertConfig(resolved)
    expect(tierIndexOfRoute(resolved.tiers, undefined, undefined)).toBeUndefined()
    expect(tierIndexOfRoute(resolved.tiers, 'p', undefined)).toBeUndefined()
    expect(tierIndexOfRoute(resolved.tiers, 'other', 'small')).toBeUndefined()
  })
})
