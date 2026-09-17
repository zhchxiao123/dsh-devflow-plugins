import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'scheduler-local-invariant'
export const inject = ['invariants']
/**
 * No runtime invariant: scheduler records are transactional local state, not an
 * emitted event stream. Service tests prove delivery and fencing relations.
 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@zhchxiao123/dsh-scheduler-local', install))
