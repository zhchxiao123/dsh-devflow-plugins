// The companion reserves this package's invariant ownership and installs
// nothing beyond it — the warn-never-vetoes rule lives in the gate specs.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as JevGateInvariantCompanion from '../src/invariant.ts'

describe('devflow-jev-gate invariant companion', () => {
  it('registers under the package name and unregisters on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const companion = ctx.plugin(JevGateInvariantCompanion)
    await companion.await()
    // Ownership is exclusive: a second reservation of the same package fails.
    expect(() => ctx.invariants.register('@zhchxiao123/dsh-devflow-jev-gate', () => {})).toThrow()
    await companion.dispose()
    const again = ctx.invariants.register('@zhchxiao123/dsh-devflow-jev-gate', () => {})
    expect(again).toBeTypeOf('function')
  })
})
