/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-automation-ui`.
 * @module @zhchxiao123/dsh-automation-ui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-automation-ui'

/** Cordis companion plugin name. */
export const name = 'client-ui-automation-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the browser half submits validated service requests
 * and renders committed state. Scheduler and GitHub state relations belong
 * to their service companions on the Host.
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
