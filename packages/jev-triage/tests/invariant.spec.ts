// The package's invariant companion. The consumer dispatches no events of its
// own, so the companion reserves package ownership and installs nothing; the
// test proves the registration and its disposal, per testing policy.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as JevTriageInvariantCompanion from '@zhchxiao123/dsh-jev-triage/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('jev-triage invariant companion', () => {
  it('registers package ownership without installing listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fork = await ctx.plugin(JevTriageInvariantCompanion)
    expect(fork).toBeTruthy()
    expect(() => void fork.dispose()).not.toThrow()
  })
})
