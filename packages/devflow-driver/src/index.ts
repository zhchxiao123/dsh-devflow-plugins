/**
 * Stage driver: a pure Consumer that turns committed `devflow/stage-changed`
 * moves into subagent dispatches. Each configured stage names a subagent
 * provider and instructions; the driver claims the card's lease (taking over
 * stale ones), starts one child whose objective is the card, heartbeats the
 * lease while the child runs, and parks the card `blocked` when the child
 * fails. The child itself advances the card through the devflow tools; the
 * driver never moves a card forward on its own.
 * @module @zhchxiao123/dsh-devflow-driver
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEV_STAGES, isDevStage } from '@zhchxiao123/dsh-devflow'
import type { CardLocation, ClaimHandle, DevActor, DevCard } from '@zhchxiao123/dsh-devflow'
// Type-only: resolves ctx.subagents for the dispatch calls.
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'devflow-driver'
export const inject = ['devflow', 'subagents', 'agents']

/** The driver's journal identity for claims and parking moves. */
const DRIVER_ACTOR: DevActor = { kind: 'command', name: 'devflow-driver' }

/** One stage's dispatch target. */
export interface StageDispatch {
  /** Registered subagent provider started for cards entering this stage. */
  provider: string
  /** Stage instructions prepended to the card objective in the child prompt. */
  instructions?: string
}

/** Stage-driver configuration. */
export interface Config {
  /** Dispatch per entered stage; unlisted stages are not driven. `done` and `blocked` cannot be driven. */
  stages?: Record<string, StageDispatch>
  /** Required cap on concurrently driven cards; further cards queue in arrival order. */
  maxConcurrentCards: number
  /** Lease heartbeats older than this are taken over (journaled `claim-expired`). */
  claimStaleAfterMs?: number
}

/** Schemastery validator supplying the driver defaults. */
export const Config: z<Config> = z.object({
  stages: z.dict(z.object({
    provider: z.string().required(),
    instructions: z.string(),
  })).default({}),
  maxConcurrentCards: z.number().required(),
  claimStaleAfterMs: z.number().default(300_000),
})

/**
 * Register the stage driver: an initial sweep of already-parked configured
 * stages, the `devflow/stage-changed` listener, and the bounded dispatch
 * queue. All registrations are effects; disposal aborts running children,
 * releases held leases, and stops the queue.
 * @param ctx - registrant context carrying the devflow store, the subagent
 *   runtime, and the agent registry.
 * @param config - deployment stage map and concurrency policy; invalid stage
 *   names or caps fail the load.
 */
export function apply(ctx: Context, config: Config): void {
  const stages = config.stages ?? {}
  const maxConcurrent = config.maxConcurrentCards
  const staleAfterMs = config.claimStaleAfterMs ?? 300_000
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('devflow-driver: maxConcurrentCards must be a positive integer')
  }
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new Error('devflow-driver: claimStaleAfterMs must be a positive integer')
  }
  for (const stage of Object.keys(stages)) {
    if (!isDevStage(stage) || stage === 'done') {
      throw new Error(`devflow-driver: stages names undrivable stage "${stage}"; use one of ${DEV_STAGES.filter(s => s !== 'done').join(', ')}`)
    }
  }
  for (const [stage, dispatch] of Object.entries(stages)) {
    if (ctx.subagents.getProvider(dispatch.provider) === undefined) {
      throw new Error(`devflow-driver: stage "${stage}" names unregistered subagent provider "${dispatch.provider}"`)
    }
  }

  const lifecycle = new AbortController()
  const queue: DevCard[] = []
  const engaged = new Set<string>()
  const lastRevision = new Map<string, number>()
  let running = 0

  // Cards from different roots may share an id; every book-keeping key is
  // therefore root + id (ids never contain spaces).
  const key = (card: DevCard): string => `${card.root} ${card.id}`

  const parent = createDriverAgent(ctx)
  ctx.effect(function* () {
    yield ctx.agents.register(parent)
    yield () => { lifecycle.abort(new Error('devflow-driver disposed')) }
  }, 'devflow-driver parent agent')

  const enqueue = (card: DevCard): void => {
    if (engaged.has(key(card)) || stages[card.stage as string] === undefined) return
    engaged.add(key(card))
    queue.push(card)
    pump()
  }

  const pump = (): void => {
    while (!lifecycle.signal.aborted && running < maxConcurrent && queue.length > 0) {
      const card = queue.shift()
      /* v8 ignore next -- the loop condition proves the queue is non-empty. */
      if (card === undefined) break
      running += 1
      void drive(card).finally(() => {
        running -= 1
        engaged.delete(key(card))
        pump()
        void resumeIfAdvanced(card)
      })
    }
  }

  /**
   * Re-enter a card its own executor advanced. The `devflow/stage-changed` for
   * that move arrives while the card is still engaged, so the listener drops it
   * as a duplicate; without this re-read the card would sit at its new stage
   * until the next activation sweep.
   * @param card - the card as dispatched, whose revision the move advanced past.
   */
  const resumeIfAdvanced = async (card: DevCard): Promise<void> => {
    if (lifecycle.signal.aborted) return
    let current: DevCard
    try {
      current = await ctx.devflow.read(card.id, card.root)
    } catch (error) {
      ctx.logger.warn(`devflow-driver: cannot re-read card ${card.id} after its stage executor finished: ${String(error)}`)
      return
    }
    if (current.stageRevision === card.stageRevision) return
    lastRevision.set(key(current), current.stageRevision)
    enqueue(current)
  }

  const drive = async (card: DevCard): Promise<void> => {
    const dispatch = stages[card.stage as string]
    /* v8 ignore next -- enqueue admits only configured stages. */
    if (dispatch === undefined) return
    if (await skipsAsRequirement(ctx, card)) return
    const claim = await ctx.devflow.claim(card.id, DRIVER_ACTOR, { staleAfterMs, root: card.root })
    if (!claim.ok) return // another worker holds a live lease; its child drives the card
    const beat = heartbeat(ctx, claim.handle, staleAfterMs)
    try {
      const run = await ctx.subagents.start(dispatch.provider, {
        label: `devflow:${card.id}`,
        parent,
        signal: lifecycle.signal,
        prompt: [{
          type: 'text',
          text: objective(card, dispatch.instructions),
        }],
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') {
          await park(ctx, card, `stage executor for "${card.stage}" ended with ${result.stopReason}`)
        }
      } finally {
        await run.dispose()
      }
    } catch (error) {
      /* v8 ignore next -- disposal racing a start rejection is timing-dependent. */
      if (!lifecycle.signal.aborted) {
        await park(ctx, card, `stage executor for "${card.stage}" failed: ${String(error)}`)
      }
    } finally {
      clearInterval(beat)
      await claim.handle.release()
    }
  }

  ctx.on('devflow/stage-changed', (card: DevCard, _from: CardLocation) => {
    const previous = lastRevision.get(key(card))
    lastRevision.set(key(card), card.stageRevision)
    if (previous !== undefined && card.stageRevision <= previous) {
      // A revision that moved backwards means the workspace changed under us
      // (e.g. a branch switch); rescan quietly instead of double-dispatching.
      void sweep(card.root)
      return
    }
    enqueue(card)
  })

  /**
   * Rescan one root's board and enqueue what sits at a driven stage.
   * @param root - the root to scan; omitted scans the store's default root,
   *   which is all the activation scan can reach — the seam has no operation
   *   enumerating roots, so cards in other roots enter through their events.
   */
  const sweep = async (root?: string): Promise<void> => {
    let cards: DevCard[]
    try {
      cards = await ctx.devflow.list(undefined, root)
    } catch (error) {
      ctx.logger.warn(`devflow-driver: sweep failed: ${String(error)}`)
      return
    }
    /* v8 ignore next -- disposal racing an in-flight sweep is timing-dependent. */
    if (lifecycle.signal.aborted) return
    for (const card of cards) {
      lastRevision.set(key(card), card.stageRevision)
      enqueue(card)
    }
  }
  // Cards already sitting at a driven stage when the driver activates are
  // swept in once; misses only warn because the listener keeps driving.
  void sweep()
}

/**
 * Whether the dispatch is skipped because the card is a decomposed
 * requirement rather than one unit of executable work: its children carry the
 * work and are dispatched instead, so the requirement never becomes a child's
 * objective.
 * @param ctx - context carrying the devflow store.
 * @param card - the card about to be dispatched.
 * @returns `true` for a card with children, and for a board that cannot be
 *   listed at all — handing a possibly-decomposed card to an executor is the
 *   worse of the two failures, and the same unreadable root would fail the
 *   claim that follows anyway.
 */
async function skipsAsRequirement(ctx: Context, card: DevCard): Promise<boolean> {
  let children: DevCard[]
  try {
    children = await ctx.devflow.list({ parent: card.id }, card.root)
  } catch (error) {
    ctx.logger.warn(`devflow-driver: cannot tell whether card ${card.id} has sub-requirements: ${String(error)}; skipping the dispatch`)
    return true
  }
  if (children.length === 0) return false
  ctx.logger.debug(`devflow-driver: card ${card.id} decomposes into ${children.length} sub-requirement(s); driving those instead`)
  return true
}

/**
 * Park a failed executor's card, against the revision it was dispatched at. A
 * `revision-mismatch` means the executor advanced the card before it failed:
 * the work it was parked for is already behind the card, so blocking whatever
 * stage it reached instead would record the wrong recovery point.
 */
async function park(ctx: Context, card: DevCard, reason: string): Promise<void> {
  let parked: { ok: boolean; code?: string; message?: string }
  try {
    parked = await ctx.devflow.transition(ctx.devflow.resolve({
      id: card.id,
      to: 'blocked',
      expectedRevision: card.stageRevision,
      by: DRIVER_ACTOR,
      reason,
      root: card.root,
    }))
  } catch (error) {
    parked = { ok: false, message: String(error) }
  }
  if (parked.ok) return
  if (parked.code === 'revision-mismatch') {
    ctx.logger.debug(`devflow-driver: card ${card.id} moved past revision ${card.stageRevision} before its executor failed; leaving it where it stands`)
    return
  }
  ctx.logger.warn(`devflow-driver: card ${card.id} executor failed and parking also failed: ${parked.message}`)
}

/** Refresh the lease on a fixed fraction of the staleness window. */
function heartbeat(ctx: Context, handle: ClaimHandle, staleAfterMs: number): ReturnType<typeof setInterval> {
  /* v8 ignore start -- the beat fires only for children outliving a third of
     the staleness window; package tests settle children immediately. */
  const interval = setInterval(() => {
    handle.heartbeat().catch((error: unknown) => {
      ctx.logger.warn(`devflow-driver: lease heartbeat for card ${handle.id} failed: ${String(error)}`)
    })
  }, Math.max(1, Math.floor(staleAfterMs / 3)))
  /* v8 ignore stop */
  interval.unref()
  return interval
}

/** The child prompt: stage instructions, the card objective, and the tool contract. */
function objective(card: DevCard, instructions: string | undefined): string {
  return [
    ...instructions === undefined ? [] : [instructions, ''],
    `You are driving devflow task card ${card.id} at stage "${card.stage}" (revision ${card.stageRevision}).`,
    '',
    `# ${card.title}`,
    '',
    card.body,
    '',
    'Work the card at this stage. When the stage\'s work is complete, move the card onward with',
    'the devflow_transition tool (register deliverables first with devflow_attach_artifact);',
    'if you cannot proceed, move it to "blocked" with a reason instead of guessing.',
  ].join('\n')
}

/** The driver's synthetic parent: a registered, never-prompted lineage anchor. */
function createDriverAgent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId(`devflow-driver-${process.pid}`))
  /* v8 ignore start -- the synthetic parent is a lineage anchor: no consumer
     prompts, steers, or maintains it, so its callback bodies never run. */
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  /* v8 ignore stop */
  return agent
}
