// The enforcement renderers as pure functions: failure feedback with its
// attempt counter and truncation, the zombie notice that names a pass that can
// no longer fail, the give-up notice that states enforcement stopped, and the
// display-path rule that keeps a configured out-of-workspace root readable.
// The turn-stopping pipeline itself is proven in the Loader composition spec.
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { displayRulePath, renderFailures, renderGiveUp, renderZombies } from '../src/check.ts'
import type { CheckFailure } from '../src/check.ts'

function failure(overrides: Partial<CheckFailure>): CheckFailure {
  return { id: 'r', title: 'T', detail: '', rulePath: '.devflow/iron-rules/r/RULE.md', ...overrides }
}

describe('displayRulePath', () => {
  it('is workspace-relative for a rule root inside the workspace', () => {
    expect(displayRulePath('/work/repo/.devflow/iron-rules/no-any', '/work/repo'))
      .toBe(['.devflow', 'iron-rules', 'no-any', 'RULE.md'].join(sep))
  })

  it('stays absolute when the configured root lives outside the workspace', () => {
    expect(displayRulePath('/etc/rules/no-any', '/work/repo')).toBe(join('/etc/rules/no-any', 'RULE.md'))
  })
})

describe('renderFailures', () => {
  it('names each rule, indents its output, and counts the attempt', () => {
    const text = renderFailures([
      failure({ id: 'no-any', title: 'Ban any', detail: 'src/a.ts:3 any\nsrc/b.ts:9 any' }),
      failure({ id: 'silent', detail: '   ' }),
    ], 2, 3, 2_000)
    expect(text).toContain('Iron rule checks failed (attempt 2/3):')
    expect(text).toContain('[no-any] Ban any')
    expect(text).toContain('  src/a.ts:3 any')
    expect(text).toContain('  src/b.ts:9 any')
    expect(text).toContain('  Rule text: .devflow/iron-rules/r/RULE.md')
    expect(text).toContain('Fix the violations above before ending this turn.')
    // Whitespace-only output contributes no detail lines: the rule-path line
    // follows the header directly.
    expect(text).toContain('[silent] T\n  Rule text:')
  })

  it('truncates long output and marks the cut', () => {
    const text = renderFailures([failure({ detail: 'x'.repeat(50) })], 1, 2, 10)
    expect(text).toContain(`  ${'x'.repeat(10)}`)
    expect(text).toContain('… (output truncated)')
    expect(text).not.toContain('x'.repeat(11))
  })

  it('marks a killed script as having produced no verdict', () => {
    expect(renderFailures([failure({ timedOut: true })], 1, 2, 100)).toContain('(check script timed out)')
  })
})

describe('renderZombies', () => {
  it('states that the passes mean nothing and points at each rule directory', () => {
    const text = renderZombies(['old-one', 'old-two'], '/work/repo/.devflow/iron-rules')
    expect(text).toContain('can no longer fail, so these passes mean nothing')
    expect(text).toContain(`[old-one] → ${join('/work/repo/.devflow/iron-rules', 'old-one')}/`)
    expect(text).toContain('`replaces`')
    expect(text).toContain('or retire it')
  })
})

describe('renderGiveUp', () => {
  it('states plainly that enforcement stopped and hands the decision to a human', () => {
    const text = renderGiveUp([failure({ id: 'a' }), failure({ id: 'b' })])
    expect(text).toContain('automatic continuation has stopped: [a] [b]')
    expect(text).toContain('Have a human confirm')
  })
})
