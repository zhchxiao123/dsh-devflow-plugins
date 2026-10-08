/**
 * Route a subagent delegation to the model its difficulty warrants.
 *
 * This is a Consumer of `ctx.jev` and knows nothing about which provider
 * answers. One ordered tier list serves as the rubric a delegation is rated
 * against, the table the model is told to choose from, and the mapping a tier
 * is turned back into a route with.
 *
 * Two facts about the harness shape everything here. A `tools/pre-execute`
 * listener cannot rewrite a call's arguments, and the delegation tool's
 * background path creates its child through the continuation manager without
 * ever reaching a subagent provider — so there is no seam that injects a route
 * silently. Routing is therefore advice plus a correction: guidance makes
 * naming a route the norm, and a judged disagreement is refused once with the
 * tier to use.
 *
 * Without a judgement credential the correction stands down and the guidance
 * remains, which is the same decision left to the model.
 * @module @zhchxiao123/dsh-jev-model-router
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@zhchxiao123/dsh-jev'
import { Config, assertConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { registerGate } from './gate.ts'
import { registerGuidance } from './guidance.ts'

export { Config, DEFAULT_JUDGE_TIMEOUT_MS, DEFAULT_TOOLS, assertConfig, routeKey, tierIndexOfRoute } from './config.ts'
export type { ResolvedConfig, ResolvedTier, Tier } from './config.ts'
export {
  CorrectionLedger, MAX_REMEMBERED_CORRECTIONS, MODEL_SELECTION_TOOL,
  correction, delegationId, readArguments, registerGate,
} from './gate.ts'
export { CONTEXT_NAME, CONTEXT_ORDER, guidanceText, registerGuidance } from './guidance.ts'
export {
  MAX_PROMPT_CHARS, QUESTION_KEY, SCORE_INSTRUCTION,
  buildQuestion, buildState, judge, tierIndexOfScore,
} from './judge.ts'
export type { Delegation, Judgement } from './judge.ts'

/** Cordis plugin name, as the Loader reports it. */
export const name = 'jev-model-router'
/**
 * All four are required. Without `jev` there is nothing to ask, without `tools`
 * no call to observe and no way to see whether the model can name a route at
 * all, and without `systemPrompt` no way to tell it the tiers — and guidance is
 * not an optional half of this plugin, it is what makes a correction rare.
 */
export const inject = ['tools', 'jev', 'systemPrompt']

/**
 * Install the guidance and the correction.
 *
 * @param ctx - the context to install on.
 * @param config - the reviewed routing configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const resolved: ResolvedConfig = config

  registerGuidance(ctx, resolved)
  registerGate(ctx, resolved)
}
