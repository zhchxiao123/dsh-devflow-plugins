/**
 * Model guidance for the devflow workflow, in two layers.
 *
 * The judgment layer is two bundled skills. `devflow-workflow` carries the
 * cross-tool process knowledge — entry judgment, service-class selection,
 * decomposition, artifact craft, rework after a veto, claim discipline —
 * that no single tool description can own. `devflow-spec-authoring` carries
 * the architecture-document judgment behind the `devflowSpec` seam and
 * registers only while a composition mounts that service, so no catalog ever
 * advertises a skill teaching an absent capability. Both skills teach
 * judgment only; per-call obligations stay in the tool descriptions and
 * their enforcement stays with the store and gates, so an unloaded skill
 * degrades nothing.
 *
 * The awareness layer is the `devflow-board` runtime context. Before each
 * model step an `agent/pre-step` listener reads the calling workspace's board
 * — `list()` on a workspace without `.devflow/` is one failed readdir with no
 * side effects — plus each card's lease via `holder()`, renders the snapshot,
 * and caches it by devflow root; a synchronous context provider serves the
 * cached text for the assembling agent's workspace. There is deliberately no
 * store-event subscription: `devflow/card-created` and `devflow/stage-changed`
 * are the seam's only emits (abandon, artifact, and archive appends fire
 * nothing), while assembly always follows a pre-step, so the per-step refresh
 * both closes that coverage gap and leaves an event listener nothing to add.
 * The harness diffs the rendered snapshot per step, so an unchanged board is
 * never re-sent.
 *
 * Named exports preserve loader injection metadata.
 * @module @zhchxiao123/dsh-devflow-guidance
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import type { DevCard } from '@zhchxiao123/dsh-devflow'
import { registerSkill, registerSpecAuthoringSkill } from './skill.ts'
import { renderSnapshot } from './snapshot.ts'
import type { SnapshotCard } from './types.ts'

export { renderSnapshot, SNAPSHOT_MAX_BYTES } from './snapshot.ts'
export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'devflow-guidance'

/**
 * The board the snapshot reads, and the registries both layers register on.
 * `devflowSpec` is deliberately absent: declaring it would keep the workflow
 * skill and the board snapshot off every composition without the spec seam,
 * so the spec-authoring skill mounts through a conditional child instead.
 */
export const inject = ['devflow', 'skills', 'systemPrompt']

/**
 * No tunables: the skill body is capability prose shipped with the package
 * (a deployment overrides it by a same-layer, lower-ranked provider of the
 * same name), and the snapshot's byte ceiling is a documented constant of the
 * awareness contract, not a deployment choice.
 */
export interface Config {}

/** Schemastery validator; an empty mapping is the whole configuration. */
export const Config: z<Config> = z.object({})

/**
 * Sort position of the `devflow-board` runtime context. Finite and unique per
 * the registry contract, above the first-party 110–120 block (whose names
 * `getContextOrder` is typed to) with room left for future first-party
 * allocations.
 */
const BOARD_CONTEXT_ORDER = 200

/**
 * Read one workspace's board into renderer facts: the card list plus one
 * lease read per card, because `list()` carries no claim information.
 * @param ctx - context carrying the devflow store.
 * @param root - absolute devflow root of the workspace.
 * @returns the renderer's card facts, in list order.
 */
async function boardCards(ctx: Context, root: string): Promise<SnapshotCard[]> {
  const cards = await ctx.devflow.list(undefined, root)
  return await Promise.all(cards.map(async (card: DevCard): Promise<SnapshotCard> => ({
    id: card.id,
    title: card.title,
    stage: card.stage,
    claimed: await ctx.devflow.holder(card.id, root) !== undefined,
  })))
}

/**
 * Apply the plugin: register the bundled `devflow-workflow` skill provider,
 * the `devflow-board` context provider, and the pre-step cache refresh. All
 * three registrations are effects of this fiber, so disposing the plugin
 * removes the skill, the context, and the listener together. The bundled
 * `devflow-spec-authoring` skill registers on a conditional child fiber that
 * follows the `devflowSpec` service in and out.
 * @param ctx - plugin context carrying the injected services.
 */
export function apply(ctx: Context): void {
  registerSkill(ctx)

  // A CONDITIONAL child (`ctx.inject`) rather than a `ctx.get()` read: the
  // Loader activates rows concurrently, so sampling the service store at
  // apply() time can register nothing, forever, with no diagnostic. The
  // child activates whenever the spec seam is composed and unwinds with it,
  // taking the skill registration along.
  ctx.inject(['devflowSpec'], (specCtx) => {
    registerSpecAuthoringSkill(specCtx)
  })

  // Rendered snapshot per devflow root. The context provider must be
  // synchronous, so it reads this cache and the async pre-step listener
  // below is the only writer. Growth is bounded at one entry, no larger than
  // the snapshot cap, per distinct workspace root whose board has cards; a
  // boardless or emptied root holds no entry.
  const boards = new Map<string, string>()

  ctx.systemPrompt.context({
    name: 'devflow-board',
    order: BOARD_CONTEXT_ORDER,
    text: (assembly: AssembleContext): string => {
      const cwd = assembly.agent?.session.header.cwd
      return cwd === undefined ? '' : boards.get(join(cwd, '.devflow')) ?? ''
    },
  })

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    // DELEGATE FIRST. This listener contributes no decision — it only
    // refreshes the cache the assembly after this waterfall reads — and
    // short-circuiting later pre-step listeners is never the price of that.
    const downstream = await next()
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return downstream
    const root = join(cwd, '.devflow')
    try {
      const text = renderSnapshot(await boardCards(ctx, root))
      if (text === '') boards.delete(root)
      else boards.set(root, text)
    } catch (error) {
      // A corrupt journal or claim record fails loudly where the model can
      // act on it — the devflow tools. Failing the model step from the
      // awareness layer adds no information, so the last snapshot stands.
      ctx.logger.warn(`devflow-guidance: board snapshot refresh failed for ${root}: ${String(error)}`)
    }
    return downstream
  })
}
