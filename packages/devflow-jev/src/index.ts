/** Project-scoped typed judgements for Devflow: service, tools, storage, web API, and client entry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { DevflowJev } from './service.ts'
import { DEFAULT_POLICY } from './rubric.ts'
import { registerSources } from './sources.ts'
import { registerGuidance } from './guidance.ts'
import { registerTools } from './tools.ts'
import { registerWeb } from './web.ts'
import type { AssessmentPolicy } from './types.ts'
import { DevflowAssistance } from './assistance.ts'
import { assistanceConfig } from './assistance-config.ts'
import type { AssistanceConfig } from './assistance-types.ts'
export * from './types.ts'
export type { WebRequest } from './web.ts'
export { assessmentRequest, decide, DEFAULT_POLICY } from './rubric.ts'
export { DevflowJev } from './service.ts'
export const name = 'devflow-jev'
export const inject = ['devflow', 'jev', 'tools', 'webServer']
export interface Config { readonly policy?: Partial<AssessmentPolicy>; readonly assistance?: Partial<AssistanceConfig> }
function policy(config: Config): AssessmentPolicy {
  // A misspelled or renamed floor must not become a silent no-op: an override
  // that names no known field is a boot failure, not a default in disguise.
  for (const key of Object.keys(config.policy ?? {})) if (!(key in DEFAULT_POLICY)) throw new Error(`devflow-jev: policy.${key} is not a policy field`)
  const value = { ...DEFAULT_POLICY, ...config.policy }
  for (const [key, number] of Object.entries(value)) if (!Number.isFinite(number) || number < 0) throw new Error(`devflow-jev: policy.${key} must be a non-negative finite number`)
  for (const key of ['codeSolvableFloor', 'informationFloor', 'choiceConfidenceFloor', 'scoreConfidenceFloor'] as const) if (value[key] > 1) throw new Error(`devflow-jev: policy.${key} must be at most 1`)
  if (value.judgementDeadlineMs <= 0) throw new Error('devflow-jev: policy.judgementDeadlineMs must be positive')
  return value
}
export function apply(ctx: Context, config: Config = {}): void {
  const assistance = assistanceConfig(config.assistance)
  ctx.plugin(DevflowJev, policy(config))
  ctx.plugin(DevflowAssistance, assistance)
  ctx.inject(['devflowJev'], (child) => { registerTools(child); child.inject(['systemPrompt'], registerGuidance); child.inject(['jevRuns'], registerSources); child.effect(() => registerWeb(child), 'devflow-jev: management route') })
}
