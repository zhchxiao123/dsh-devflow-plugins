/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-github-sync-local`.
 * @module @zhchxiao123/dsh-github-sync-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-github-sync-local'

/** Cordis companion plugin name. */
export const name = 'github-sync-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider emits no content events; version/change
 * relations and lease fencing are enforced inside SQLite transactions and
 * exercised through the public service in its behavior tests.
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
