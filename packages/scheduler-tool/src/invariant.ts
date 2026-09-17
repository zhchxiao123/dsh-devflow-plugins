/** Invariant ownership belongs to the service provider; tools only project its results. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'scheduler-tool-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = () => {}
/** Reserve the companion without duplicating provider invariants. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@zhchxiao123/dsh-scheduler-tool', install))
