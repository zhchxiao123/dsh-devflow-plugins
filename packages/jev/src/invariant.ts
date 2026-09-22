/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-jev`.
 * @module @zhchxiao123/dsh-jev/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-jev'

/** Cordis companion plugin name. */
export const name = 'jev-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this Service Definition owns no registry and emits no
 * event stream. Its three contract relations — answers restricted to asked
 * keys, unanswered questions left absent, failures raised rather than returned
 * — all hold within a single `ask()` call stack and are asserted there, so an
 * observer watching from outside would have nothing independent to compare.
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
