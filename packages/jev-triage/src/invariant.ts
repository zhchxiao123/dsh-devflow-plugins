/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-jev-triage`.
 * @module @zhchxiao123/dsh-jev-triage/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-jev-triage'

/** Cordis companion plugin name. */
export const name = 'jev-triage-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this Consumer registers one read-only tool and emits no
 * event stream. Its one relation — every changed file landing in exactly one of
 * review or skip — is a property of a single `execute` call, settled before the
 * value is returned and covered by this package's own specs.
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
