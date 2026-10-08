/**
 * Correcting a delegation that is about to run on the wrong model.
 *
 * The harness does not let a policy listener rewrite a tool call's arguments —
 * they are already logged and presented by the time `tools/pre-execute` runs —
 * and the delegation tool's background path never reaches a subagent provider,
 * so there is no seam that could inject a route behind the model's back. What
 * is available is refusal with a reason the model reads, so that is the shape:
 * judge the pending delegation, and when the picked route disagrees with the
 * judgement, deny once naming the route to use.
 *
 * Once. A model that re-picks the same wrong tier would otherwise be denied
 * forever, turning a routing preference into a dead delegation.
 * @module @zhchxiao123/dsh-jev-model-router/gate
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@zhchxiao123/dsh-jev'
import { tierIndexOfRoute } from './config.ts'
import type { ResolvedConfig, ResolvedTier } from './config.ts'
import { judge } from './judge.ts'
import type { Delegation } from './judge.ts'

/**
 * The tool whose presence means the model can name a route at all. It is
 * registered only by a delegation tool with model selection enabled, and its
 * name is global, so one lookup answers "is there anything a correction could
 * ask for" without this package reading another plugin's configuration.
 */
export const MODEL_SELECTION_TOOL = 'list_subagent_models'

/**
 * Corrections remembered per agent. Bounded, because a long session delegates
 * many times and nothing here is worth leaking memory over; the oldest entry
 * is dropped, which at worst allows one extra correction for a delegation the
 * model returned to much later.
 */
export const MAX_REMEMBERED_CORRECTIONS = 256

/** The model-facing route fields of one delegation call. */
interface DelegationArguments {
  readonly description?: string
  readonly prompt?: string
  readonly provider?: string
  readonly model?: string
}

/**
 * Read the fields this router needs out of one tool call's arguments.
 *
 * The arguments are model-authored JSON that the tool itself validates later,
 * so every field is checked rather than assumed: a delegation whose prompt is
 * not a string is not something to judge, and letting the tool reject it
 * reports the real defect.
 *
 * @param raw - the parsed arguments as the model supplied them.
 * @returns the fields, with anything of the wrong type left absent.
 */
export function readArguments(raw: unknown): DelegationArguments {
  if (raw === null || typeof raw !== 'object') return {}
  const args = raw as Record<string, unknown>
  const read: { -readonly [K in keyof DelegationArguments]: string } = {}
  for (const field of ['description', 'prompt', 'provider', 'model'] as const) {
    const value = args[field]
    if (typeof value === 'string' && value.length > 0) read[field] = value
  }
  return read
}

/**
 * Identify one delegation across retries.
 *
 * The tool call id cannot serve: a corrected delegation is a NEW call with a
 * new id, so keying on it would let the same work be denied without limit. The
 * prompt is what survives the retry.
 *
 * @param prompt - the delegated prompt.
 * @returns a short stable digest.
 */
export function delegationId(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 32)
}

/** Per-agent memory of delegations already corrected once. */
export class CorrectionLedger {
  private readonly perAgent = new WeakMap<Agent, Set<string>>()

  /**
   * Record one correction, and report whether this delegation had already been
   * corrected before now.
   * @param agent - the delegating agent.
   * @param id - the delegation's stable digest.
   * @returns whether a correction was already spent on this delegation.
   */
  spend(agent: Agent, id: string): boolean {
    let seen = this.perAgent.get(agent)
    if (seen === undefined) {
      seen = new Set<string>()
      this.perAgent.set(agent, seen)
    }
    if (seen.has(id)) return true
    if (seen.size >= MAX_REMEMBERED_CORRECTIONS) {
      const oldest = seen.values().next()
      /* v8 ignore next -- a size at the cap implies a first entry; the guard satisfies the iterator result type. */
      if (oldest.done !== true) seen.delete(oldest.value)
    }
    seen.add(id)
    return false
  }
}

/**
 * Compose the text a denied delegation reads.
 *
 * It names the tier, its exact route, and the situation that tier covers, so
 * the model's next attempt needs no further guessing.
 *
 * @param tier - the tier the judgement chose.
 * @param toolName - the delegation tool to retry on.
 * @returns the denial reason.
 */
export function correction(tier: ResolvedTier, toolName: string): string {
  return [
    `This delegation belongs on the "${tier.key}" model tier: ${tier.when}`,
    `Re-issue the same ${toolName} call with provider "${tier.provider}" and model "${tier.model}"`,
    tier.reasoningEffort === undefined ? '' : ` and reasoning_effort "${tier.reasoningEffort}"`,
    '. Keep the prompt unchanged; only the route was wrong.',
  ].join('')
}

/**
 * Install the routing correction.
 *
 * @param ctx - context carrying the tool registry and the judgement seam.
 * @param config - the governed tools and the tiers.
 */
export function registerGate(ctx: Context, config: ResolvedConfig): void {
  const ledger = new CorrectionLedger()
  // Per load, not per delegation: an inert router is one deployment fact, and
  // repeating it once per dispatch would bury it.
  let warnedInert = false

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    if (!config.tools.includes(exec.name)) return next()
    const agent = exec.agent
    if (agent === undefined) return next()

    // Nothing a correction could ask for: the delegation tool exposes no route
    // fields, and this router cannot enable them — that is another plugin's
    // load-time configuration, sampled into the session and fixed thereafter.
    if (ctx.tools.get(MODEL_SELECTION_TOOL, agent) === undefined) {
      if (!warnedInert) {
        warnedInert = true
        ctx.logger.warn(
          `jev-model-router: ${exec.name} is governed but ${MODEL_SELECTION_TOOL} is not visible, `
          + 'so no delegation can be routed. Enable `modelSelectionSettings` on the delegation tool '
          + 'and record a non-empty subagent-model-selection route list, or unmount this router.',
        )
      }
      return next()
    }

    let status
    try {
      status = await ctx.jev.configurationStatus()
    } catch {
      // A resolver failure can carry credential material in its cause; the only
      // safe reading of it is "not configured".
      return next()
    }
    // The degradation: the gate stands down and the guidance stays, so the
    // model keeps choosing from the same tier table without being corrected.
    if (status !== 'configured') return next()

    const args = readArguments(exec.arguments)
    if (args.prompt === undefined) return next()

    const verdict = await judge(ctx.jev, delegationOf(args, agent), config, exec.signal)
    // A withdrawn dispatch is not a routing outcome. Allowing lets the registry
    // apply its own post-listener cancellation check, which reports the
    // interrupt as the interrupt it was.
    if (verdict.kind !== 'tier') return next()

    const chosen = tierIndexOfRoute(config.tiers, args.provider, args.model)
    if (chosen === verdict.index) return next()

    const id = delegationId(args.prompt)
    if (ledger.spend(agent, id)) return next()

    const tier = config.tiers[verdict.index]
    /* v8 ignore next -- the index is clamped to the tier list by `tierIndexOfScore`. */
    if (tier === undefined) return next()
    return { kind: 'deny', reason: correction(tier, exec.name) }
  })
}

/**
 * Assemble the evidence one delegation is judged on.
 *
 * @param args - the delegation's model-authored fields.
 * @param agent - the delegating parent, for its own route.
 * @returns the judgement's evidence.
 */
function delegationOf(args: DelegationArguments, agent: Agent): Delegation {
  const parent = agent.options
  const parentRoute = parent.provider === undefined || parent.model === undefined
    ? undefined
    : `${parent.provider}/${parent.model}`
  return {
    ...args.description === undefined ? {} : { description: args.description },
    /* v8 ignore next -- the caller checks for an absent prompt before judging. */
    prompt: args.prompt ?? '',
    ...parentRoute === undefined ? {} : { parentRoute },
  }
}
