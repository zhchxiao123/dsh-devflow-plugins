/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-devflow-guidance`.
 * @module @zhchxiao123/dsh-devflow-guidance/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-devflow-guidance'

/** Cordis companion plugin name. */
export const name = 'devflow-guidance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers one static bundled skill and
 * appends to no journal and publishes no event stream a data relation could
 * be checked against. Its one structural contract — the shipped asset backs
 * the registered candidate — fails loudly in `ctx.skills.get()` when the
 * file is missing, and the composition test proves the file ships.
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
