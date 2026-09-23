/** Project-scoped typed judgements for Devflow: service, tools, storage, web API, and client entry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { DevflowJev } from './service.ts'
import { DEFAULT_POLICY } from './rubric.ts'
import { registerSources } from './sources.ts'
import { registerTools } from './tools.ts'
import { registerWeb } from './web.ts'
import type { AssessmentPolicy } from './types.ts'
export * from './types.ts'
export type { WebRequest } from './web.ts'
export { assessmentRequest, decide, DEFAULT_POLICY } from './rubric.ts'
export { DevflowJev } from './service.ts'
export const name = 'devflow-jev'
export const inject = ['devflow', 'jev', 'tools', 'webServer']
export interface Config { readonly policy?: Partial<AssessmentPolicy> }
function policy(config: Config): AssessmentPolicy {
  const value = { ...DEFAULT_POLICY, ...config.policy }
  for (const [key, number] of Object.entries(value)) if (!Number.isFinite(number) || number < 0) throw new Error(`devflow-jev: policy.${key} must be a non-negative finite number`)
  for (const key of ['codeSolvableFloor', 'informationFloor', 'confidenceFloor'] as const) if (value[key] > 1) throw new Error(`devflow-jev: policy.${key} must be at most 1`)
  return value
}
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(DevflowJev, policy(config))
  ctx.inject(['devflowJev'], (child) => { registerTools(child); child.inject(['jevRuns'], registerSources); child.effect(() => registerWeb(child), 'devflow-jev: management route') })
}
