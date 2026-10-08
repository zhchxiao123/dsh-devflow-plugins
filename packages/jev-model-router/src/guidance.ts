/**
 * Telling the model which tiers exist, so choosing a route is the norm rather
 * than something a correction has to teach one delegation at a time.
 *
 * This is also the whole of the degraded mode. With no judgement credential the
 * gate stands down and only this contribution remains, which is the same
 * decision made by the model instead of by code — the tier descriptions it
 * reads are the ones the judgement would have rated against.
 *
 * Configuration is resolved during assembly rather than held from load, so the
 * very first model request carries current guidance and a rotated or removed
 * credential reaches the next one.
 * @module @zhchxiao123/dsh-jev-model-router/guidance
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@zhchxiao123/dsh-jev'
import { MODEL_SELECTION_TOOL } from './gate.ts'
import type { ResolvedConfig } from './config.ts'

/** The ordered context this package contributes under. */
export const CONTEXT_NAME = 'jev-model-router'
/** Just after `jev-usage`, so the two judgement-related blocks stay adjacent. */
export const CONTEXT_ORDER = 221

/**
 * Compose the guidance text.
 *
 * @param config - the governed tools and the tiers.
 * @param enforced - whether a judgement will correct a disagreeing pick.
 * @returns the contribution's text.
 */
export function guidanceText(config: ResolvedConfig, enforced: boolean): string {
  const tools = config.tools.map(tool => `\`${tool}\``).join(', ')
  return [
    `Subagent model routing: when delegating through ${tools}, always set \`provider\` and \`model\` explicitly. Choose the weakest tier that fits the work:`,
    ...config.tiers.map(tier =>
      `- ${tier.key} (provider "${tier.provider}", model "${tier.model}"${tier.reasoningEffort === undefined ? '' : `, reasoning_effort "${tier.reasoningEffort}"`}): ${tier.when}`),
    'Rate the delegated task, not its wording: how much reading and cross-file reasoning it takes, and how costly a wrong result would be. An omitted route leaves the child on this session\'s own model, which is rarely the right size for delegated work.',
    ...enforced
      ? ['A routing judgement checks each delegation. If your pick disagrees with it, the call is refused once with the tier to use; re-issue it with that route and an unchanged prompt.']
      : [],
  ].join('\n')
}

/**
 * Contribute the guidance.
 *
 * The empty ordered context is registered first and filled after `next()`, and
 * only when that named entry survives in the returned assembly — which is what
 * keeps scope, runtime-context suppression, and contribution disposal
 * authoritative over this package.
 *
 * @param ctx - context carrying the system-prompt service and the tool registry.
 * @param config - the governed tools and the tiers.
 */
export function registerGuidance(ctx: Context, config: ResolvedConfig): void {
  ctx.systemPrompt.context({ name: CONTEXT_NAME, order: CONTEXT_ORDER, text: '' })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const entry = assembly.contexts.find(context => context.name === CONTEXT_NAME)
    if (entry === undefined || agent === undefined) return assembly
    // Tool visibility is checked for the agent being assembled, every time:
    // guidance for route fields that this agent's delegation tool does not
    // expose would ask for something it cannot do.
    if (ctx.tools.get(MODEL_SELECTION_TOOL, agent) === undefined) return assembly
    let status
    try {
      status = await ctx.jev.configurationStatus()
    } catch {
      // Suppressing the enforcement sentence is the conservative reading: the
      // table is still right, only the claim that it is checked would not be.
      status = 'unconfigured' as const
    }
    entry.text = guidanceText(config, status === 'configured')
    return assembly
  })
}
