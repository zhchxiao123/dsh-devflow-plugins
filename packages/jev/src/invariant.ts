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
 * No cross-package runtime invariant: typed calls are asserted within `ask()`,
 * while durable run manifests and state are validated by their storage adapter.
 * Neither surface exposes an independent registry or event stream that this
 * companion could compare without duplicating the package's own checks.
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
