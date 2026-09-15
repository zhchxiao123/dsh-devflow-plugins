/**
 * Midscene guidance, session-owned browser jobs, fresh completion validators
 * and read-only diagnostic projections. Loading the plugin starts no browser,
 * model request or background acceptance task.
 * @module @zhchxiao123/dsh-devflow-midscene
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerSkill } from './skill.ts'
import { Config, validateProfiles } from './config.ts'
import { registerManagedTools, registerManagedValidators } from './managed.ts'
import { registerSummary } from './summary.ts'
export { Config } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'devflow-midscene'
/** Only the skill catalog is required by the plugin half. */
export const inject = ['skills']

/**
 * Make the acceptance runbook discoverable in the current skill catalog.
 * @param ctx - fiber owning the skill registration.
 */
export function apply(ctx: Context, config: Config = { profiles: {} }): void {
  validateProfiles(config)
  registerSkill(ctx)
  registerSummary(ctx, config)
  ctx.inject(['tools'], (child) => { registerManagedTools(child, config) })
  ctx.inject(['devflowValidators'], (child) => { registerManagedValidators(child, config) })
}
