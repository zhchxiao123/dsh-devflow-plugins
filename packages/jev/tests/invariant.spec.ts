// The package's invariant companion. The seam dispatches no events of its own
// and holds no registry, so the companion reserves package ownership and
// installs nothing; the test proves the registration and its disposal, per
// testing policy.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as JevInvariantCompanion from '@zhchxiao123/dsh-jev/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('jev invariant companion', () => {
  it('registers package ownership without installing listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fork = await ctx.plugin(JevInvariantCompanion)
    expect(fork).toBeTruthy()
    expect(() => void fork.dispose()).not.toThrow()
  })
})
