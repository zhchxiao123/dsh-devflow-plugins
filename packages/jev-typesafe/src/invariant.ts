/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-jev-typesafe`.
 * @module @zhchxiao123/dsh-jev-typesafe/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-jev-typesafe'

/** Cordis companion plugin name. */
export const name = 'jev-typesafe-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this Service Provider owns no registry and emits no
 * event stream. Its one durable relation — the credential reference resolved
 * on every call rather than cached — is a call-order property inside
 * `perform()` with no observable trace for an invariant to compare, and is
 * covered by this package's own specs instead.
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
