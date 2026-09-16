/** Cordis invariant ownership for the optional Midscene skill plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Stable companion name. */
export const name = 'devflow-midscene-invariant'
/** Registry required for companion ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the jobs registry owns job identity and cancellation;
 * Devflow owns transition commits. This plugin validates complete worker and
 * report evidence before returning a verdict. An observer of intermediate file
 * writes cannot establish an additional committed-state relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Reserve the package's invariant companion on this fiber.
 * @param ctx - context carrying the invariant registry.
 * @returns disposer for the registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@zhchxiao123/dsh-devflow-midscene', install))
