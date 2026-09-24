/**
 * Judgement policy on the `devflow/transition` waterfall: configured edges run
 * the stage rubric through `ctx.devflowJev` and record the verdict in the
 * transition journal's gate checks. A `warn` edge never vetoes — its records
 * are the calibration data that must exist before anyone grants the model
 * veto power. An `enforce` edge vetoes only on the conditions its
 * configuration spells out, and says which numbers triggered it.
 *
 * Judgements ride the existing evaluation store: every check line names its
 * evaluation id, so the full answers and any later human accept/reject stay
 * reachable from the journal.
 * @module @zhchxiao123/dsh-devflow-jev-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@zhchxiao123/dsh-devflow-jev'
import { assertConfig } from './config.ts'
import { fence } from './gate.ts'
import type { Assess } from './gate.ts'
import type { Config } from './types.ts'

export type { Config, EdgeMode, EdgePolicy, VetoConditions } from './types.ts'
export { assertConfig } from './config.ts'

export const name = 'devflow-jev-gate'
export const inject = ['devflow', 'devflowJev']

/**
 * Register the judgement listener on the transition waterfall.
 * @param ctx - registrant context carrying the devflow store and the
 *   judgement service.
 * @param config - the composition-supplied edge policies.
 */
export function apply(ctx: Context, config: Config): void {
  const policies = assertConfig(config)
  const assess: Assess = (root, id, kind, signal) =>
    ctx.devflowJev.assess(root, { target: 'card', id, assessmentKind: kind }, signal)
  ctx.effect(() => ctx.on('devflow/transition', fence(policies, assess)), 'devflow-jev-gate: judgement fence')
}
