import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'automation-project-invariant'
export const inject = ['invariants']
/**
 * No runtime invariant: automation-project project resolution is a read-only mapping of published workspace
 * and session services; it emits no events. Tests prove refusal without a registered project.
 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@zhchxiao123/dsh-automation-project', install))
