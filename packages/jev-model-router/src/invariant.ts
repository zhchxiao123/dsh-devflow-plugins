/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-jev-model-router`.
 * @module @zhchxiao123/dsh-jev-model-router/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-jev-model-router'

/** Cordis companion plugin name. */
export const name = 'jev-model-router-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant. This Consumer's one relation — a delegation is denied
 * at most once — is held by {@link CorrectionLedger}, whose whole state is
 * private to this package and reachable only through the `spend` call that
 * updates it. An observer watching from outside would have no independent
 * record to compare against, so it would be asserting this package's own
 * bookkeeping against itself; `tests/gate.spec.ts` covers the relation where
 * the second attempt is actually observable.
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
