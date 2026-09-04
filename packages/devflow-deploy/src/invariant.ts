/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-devflow-deploy`.
 * @module @zhchxiao123/dsh-devflow-deploy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-devflow-deploy'

/** Cordis companion plugin name. */
export const name = 'devflow-deploy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends to no journal and publishes no
 * event stream a data relation could be checked against. Its one structural
 * contract — a driver promises a rollback iff it implements one — is a
 * relation of the registration itself, so `DriverRegistry.register` enforces
 * it at the earliest resolvable point rather than deferring it to a check
 * with nothing to observe.
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
