import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'devflow-jev-invariant'
export const inject = ['invariants']
// No runtime invariant: assistance records are advisory snapshots, not stage-transition authority.
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@zhchxiao123/dsh-devflow-jev', install))
