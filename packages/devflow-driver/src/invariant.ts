/**
 * Package-owned invariant companion for `@zhchxiao123/dsh-devflow-driver`.
 * @module @zhchxiao123/dsh-devflow-driver/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@zhchxiao123/dsh-devflow-driver'

/** Cordis companion plugin name. */
export const name = 'devflow-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the driver only consumes `devflow/stage-changed`
 * (whose stream relations the `@zhchxiao123/dsh-devflow` companion owns) and
 * dispatches through the subagent seam; its own guarantees — lease exclusivity,
 * concurrency caps, failure parking — are lifecycle effects proven by package
 * tests.
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
