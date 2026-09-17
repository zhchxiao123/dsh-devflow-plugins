/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-automation-web`.
 * @module @zhchxiao123/dsh-automation-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-automation-web'

/** Cordis companion plugin name. */
export const name = 'automation-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every request re-reads the authoritative store and the
 * route registration mutates in one owned effect, so this package holds no
 * state a scheduling or sync relation could contradict. Those relations are
 * asserted by the scheduler and GitHub sync provider companions.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
