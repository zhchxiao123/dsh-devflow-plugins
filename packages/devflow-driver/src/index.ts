/**
 * Stage driver: a pure Consumer that turns committed `devflow/stage-changed`
 * moves into subagent dispatches. Each configured stage names a subagent
 * provider and instructions; cards wait while that provider is not registered,
 * which keeps independently mounted providers safe under concurrent Loader
 * activation. Each child receives the current deployment provider/model route
 * from `agentDefaultModel`. The driver claims the card's lease (taking over
 * stale ones), starts one child whose objective is the card, heartbeats the
 * lease while the child runs, and parks the card `blocked` when the child
 * fails. The child itself advances the card through the devflow tools; the
 * driver never moves a card forward on its own.
 *
 * A stage's `inputs` inline the newest registration of each listed artifact
 * kind into the child prompt, best-effort: an unregistered kind or an
 * unreadable file never blocks the dispatch. A stage's `produces` names the
 * deliverable kind the child must register, rendered with the kind's structure
 * template when the optional `devflowArtifactSpecs` service declares one.
 * @module @zhchxiao123/dsh-devflow-driver
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves ctx.agentDefaultModel for child model routing.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEV_STAGES, isDevStage } from '@zhchxiao123/dsh-devflow'
import type { CardLocation, ClaimHandle, DevActor, DevCard } from '@zhchxiao123/dsh-devflow'
// Type-only: the produced kind's spec shape and the optional
// devflowArtifactSpecs service it is read from.
import type { ArtifactKindSpec } from '@zhchxiao123/dsh-devflow-artifact-gate'
// Type-only: resolves ctx.subagents for the dispatch calls.
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'devflow-driver'
export const inject = ['devflow', 'subagents', 'agents', 'agentDefaultModel']

/** The driver's journal identity for claims and parking moves. */
const DRIVER_ACTOR: DevActor = { kind: 'command', name: 'devflow-driver' }

/** One stage's dispatch target. */
export interface StageDispatch {
  /** Registered subagent provider started for cards entering this stage. */
  provider: string
  /** Stage instructions prepended to the card objective in the child prompt. */
  instructions?: string
  /**
   * Artifact kinds whose newest registration is inlined into the child prompt,
   * between the card body and the closing contract. Best-effort: an
   * unregistered kind skips silently (the first round has no review yet) and
   * an unreadable file warns and skips.
   */
  inputs?: string[]
  /**
   * Deliverable kind the child is instructed to register with
   * `devflow_attach_artifact`'s kind + content form, rendered with the kind's
   * structure template when the optional `devflowArtifactSpecs` service
   * declares one.
   */
  produces?: string
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
    inputs: z.array(z.string()),
    produces: z.string(),
  })).default({}),
  maxConcurrentCards: z.number().required(),
  claimStaleAfterMs: z.number().default(300_000),
})

/**
 * Kind grammar, restated from the seam's store-written artifact registration
 * (`ARTIFACT_KIND` in `@zhchxiao123/dsh-devflow-filesystem`): lowercase
 * letters, digits, and dashes, starting alphanumeric. A divergence from the
 * original is a defect in this copy.
 */
const ARTIFACT_KIND = /^[a-z0-9][a-z0-9-]*$/

/**
 * Register the stage driver: an initial sweep of already-parked configured
 * stages, the `devflow/stage-changed` listener, and the bounded dispatch
 * queue. All registrations are effects; disposal aborts running children,
 * releases held leases, and stops the queue.
 * @param ctx - registrant context carrying the devflow store, the subagent
 *   runtime, the agent registry, and the default model selection.
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
  for (const [stage, dispatch] of Object.entries(stages)) {
    if (!isDevStage(stage) || stage === 'done') {
      throw new Error(`devflow-driver: stages names undrivable stage "${stage}"; use one of ${DEV_STAGES.filter(s => s !== 'done').join(', ')}`)
    }
    for (const [index, kind] of (dispatch.inputs ?? []).entries()) {
      if (!ARTIFACT_KIND.test(kind)) {
        throw new Error(`devflow-driver: stages["${stage}"].inputs[${index}] names invalid kind ${JSON.stringify(kind)}; a kind is lowercase letters, digits, and dashes, starting alphanumeric`)
      }
    }
    if (dispatch.produces !== undefined && !ARTIFACT_KIND.test(dispatch.produces)) {
      throw new Error(`devflow-driver: stages["${stage}"].produces names invalid kind ${JSON.stringify(dispatch.produces)}; a kind is lowercase letters, digits, and dashes, starting alphanumeric`)
    }
  }
  const lifecycle = new AbortController()
  const queue: DevCard[] = []
  const waiting = new Map<string, DevCard>()
  const waitingProviders = new Set<string>()
  const parents = new Map<string, Agent>()
  const engaged = new Set<string>()
  const reenterAfterDrive = new Set<string>()
  const lastRevision = new Map<string, number>()
  let parentSequence = 0
  let running = 0

  // Cards from different roots may share an id; every book-keeping key is
  // therefore root + id (ids never contain spaces).
  const key = (card: DevCard): string => `${card.root} ${card.id}`

  ctx.effect(function* () {
    yield () => { lifecycle.abort(new Error('devflow-driver disposed')) }
  }, 'devflow-driver lifecycle')

  const parentFor = (root: string): Agent => {
    const existing = parents.get(root)
    if (existing !== undefined) return existing
    const parent = createDriverAgent(ctx, dirname(root), ++parentSequence)
    ctx.effect(function* () {
      yield ctx.agents.register(parent)
    }, 'devflow-driver parent agent')
    parents.set(root, parent)
    return parent
  }

  const enqueue = (card: DevCard): void => {
    const cardKey = key(card)
    const dispatch = stages[card.stage as string]
    if (dispatch === undefined) {
      waiting.delete(cardKey)
      return
    }
    if (engaged.has(cardKey)) return
    if (ctx.subagents.getProvider(dispatch.provider) === undefined) {
      waiting.set(cardKey, card)
      if (!waitingProviders.has(dispatch.provider)) {
        waitingProviders.add(dispatch.provider)
        ctx.logger.debug(`devflow-driver: waiting for subagent provider "${dispatch.provider}"`)
      }
      return
    }
    waiting.delete(cardKey)
    engaged.add(cardKey)
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
        const mustReenter = reenterAfterDrive.delete(key(card))
        pump()
        void resumeIfAdvanced(card, mustReenter)
      })
    }
  }

  /**
   * Re-enter a card its own executor advanced. The `devflow/stage-changed` for
   * that move arrives while the card is still engaged, so the listener drops it
   * as a duplicate; without this re-read the card would sit at its new stage
   * until the next activation sweep.
   * @param card - the card as dispatched, whose revision the move advanced past.
   * @param mustReenter - a revision regression requested a rescan while this
   *   card was still engaged, so equality with the dispatched revision does
   *   not cancel the re-entry.
   */
  const resumeIfAdvanced = async (card: DevCard, mustReenter: boolean): Promise<void> => {
    if (lifecycle.signal.aborted) return
    let current: DevCard
    try {
      current = await ctx.devflow.read(card.id, card.root)
    } catch (error) {
      ctx.logger.warn(`devflow-driver: cannot re-read card ${card.id} after its stage executor finished: ${String(error)}`)
      return
    }
    if (!mustReenter && current.stageRevision === card.stageRevision) return
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
      const selection = ctx.agentDefaultModel.currentSelection()
      const inputs = await inputArtifacts(ctx, card, dispatch.inputs ?? [])
      const run = await ctx.subagents.start(dispatch.provider, {
        label: `devflow:${card.id}`,
        parent: parentFor(card.root),
        signal: lifecycle.signal,
        agentOptions: { provider: selection.provider, model: selection.model },
        prompt: [{
          type: 'text',
          text: objective(card, dispatch, inputs, producedSpec(ctx, dispatch.produces)),
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
      // (e.g. a branch switch). Remember an engaged card because the immediate
      // sweep cannot enqueue it until its current child exits.
      if (card.stageRevision < previous && engaged.has(key(card))) reenterAfterDrive.add(key(card))
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
  ctx.on('subagent/provider-added', (provider) => {
    waitingProviders.delete(provider.name)
    for (const card of waiting.values()) {
      if (stages[card.stage as string]?.provider === provider.name) enqueue(card)
    }
  })
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

/** One input artifact fed into the child prompt: the newest registration of its kind. */
interface FedArtifact {
  kind: string
  rev: number
  content: string
}

/**
 * Read the newest registration of each input kind for inlining into the child
 * prompt. Feeding is best-effort — the opposite of the artifact gate's
 * fail-closed check: a kind with no registration skips silently (the first
 * round has no review yet), and an unreadable registered file warns and skips,
 * because the child can still work the card from its body while refusing to
 * dispatch would stall the board over missing context.
 * @param ctx - context carrying the logger for the unreadable-file warning.
 * @param card - the card as dispatched, whose records name the registrations.
 * @param kinds - the stage's configured input kinds, in feed order.
 * @returns the readable registrations, each with its journal revision.
 */
async function inputArtifacts(ctx: Context, card: DevCard, kinds: readonly string[]): Promise<FedArtifact[]> {
  const fed: FedArtifact[] = []
  for (const kind of kinds) {
    // Records are in registration order and revisions only grow, so the last
    // record of a kind is the one with the highest revision.
    const newest = card.artifactRecords.filter(record => record.kind === kind).at(-1)
    if (newest === undefined) continue
    // The record's path is journal-recorded relative to the card directory,
    // which the seam names as the card file's parent.
    try {
      fed.push({ kind, rev: newest.rev, content: await readFile(join(dirname(card.path), newest.path), 'utf8') })
    } catch (error) {
      ctx.logger.warn(`devflow-driver: input artifact "${kind}" (${newest.path}) on card ${card.id} cannot be read: ${String(error)}; dispatching without it`)
    }
  }
  return fed
}

/** The produced kind's structure spec, when the optional spec service is present and declares the kind. */
function producedSpec(ctx: Context, kind: string | undefined): ArtifactKindSpec | undefined {
  return kind === undefined ? undefined : ctx.get('devflowArtifactSpecs')?.[kind]
}

/**
 * The child prompt: stage instructions, the card objective, the fed input
 * artifacts, the produced-kind contract, and the tool contract. A stage with
 * neither `inputs` nor `produces` yields exactly the pre-contract prompt.
 */
function objective(card: DevCard, dispatch: StageDispatch, inputs: readonly FedArtifact[], spec: ArtifactKindSpec | undefined): string {
  return [
    ...dispatch.instructions === undefined ? [] : [dispatch.instructions, ''],
    `You are driving devflow task card ${card.id} at stage "${card.stage}" (revision ${card.stageRevision}).`,
    '',
    `# ${card.title}`,
    '',
    card.body,
    '',
    ...inputs.flatMap(artifact => [`--- artifact ${artifact.kind} (rev ${artifact.rev}) ---`, artifact.content, '']),
    ...producesLines(dispatch.produces, spec),
    'Work the card at this stage. When the stage\'s work is complete, move the card onward with',
    'the devflow_transition tool (register deliverables first with devflow_attach_artifact);',
    'if you cannot proceed, move it to "blocked" with a reason instead of guessing.',
  ].join('\n')
}

/**
 * The produced-kind contract lines: the deliverable's shape when its spec is
 * known, and the registration instruction always. Without a spec — the spec
 * service absent, or the kind declared with no structure — the child is still
 * told what kind to register, just not what shape it takes.
 */
function producesLines(kind: string | undefined, spec: ArtifactKindSpec | undefined): string[] {
  if (kind === undefined) return []
  const shape = spec === undefined ? [] : shapeLines(spec)
  return [
    ...shape.length === 0
      ? [`This stage's deliverable is a "${kind}" artifact.`]
      : [`This stage's deliverable is a "${kind}" artifact, shaped like:`, '', ...shape],
    `Register its complete Markdown with devflow_attach_artifact's kind + content form (kind "${kind}");`,
    'the store writes and records the file itself.',
    '',
  ]
}

/** The template skeleton of one kind's spec: the required frontmatter fields and section titles. */
function shapeLines(spec: ArtifactKindSpec): string[] {
  const frontmatter = spec.frontmatter ?? []
  const sections = spec.sections ?? []
  return [
    ...frontmatter.length === 0 ? [] : ['---', ...frontmatter.map(field => `${field}: <value>`), '---', ''],
    ...sections.flatMap(title => [`## ${title}`, '', '…', '']),
  ]
}

/** One root's synthetic parent: a registered, never-prompted lineage and workspace anchor. */
function createDriverAgent(ctx: Context, cwd: string, sequence: number): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(`devflow-driver-${process.pid}-${sequence}`)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
  })
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
