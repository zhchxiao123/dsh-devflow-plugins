/**
 * Service Definition of the `ctx.devflow` capability seam: file-backed task
 * cards whose stage moves through a fixed pipeline. This package owns the card
 * vocabulary and the journal decode/replay used by every consumer. Storage
 * mechanics belong to a provider such as `@zhchxiao123/dsh-devflow-filesystem`;
 * model-facing tools belong to `@zhchxiao123/dsh-devflow-tool`.
 * @module @zhchxiao123/dsh-devflow
 */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: resolve the optional `ctx.sessions` and `ctx.sessionPersistence`
// lookups the session-scoped reads use for session-to-root resolution.
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {
  ArtifactRequest,
  ArtifactResult,
  CardFilter,
  ClaimHolder,
  ClaimOptions,
  ClaimResult,
  CreateRequest,
  CreateResult,
  CreateSpec,
  DevActor,
  DevCard,
  DevCardDetail,
  DevflowCardId,
  DevflowJournalEntry,
  TransitionRequest,
  TransitionResult,
  TransitionSpec,
} from './types.ts'

export type * from './types.ts'
export { DEV_STAGES, DevflowCardId, isCardLocation, isDevStage, isLegalTransition, isReworkEdge } from './stages.ts'
export { decodeJournalEntry, foldJournal } from './journal.ts'
export type { JournalFoldState } from './journal.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devflow: DevflowStore
  }
}

/**
 * Abstract task-card store registered as `ctx.devflow` (one implementation per
 * context; loading a second throws, cordis' standard duplicate-service
 * behavior). Subclass, implement the abstract methods, and load the subclass
 * as a plugin.
 *
 * Implementations must honor these read-side semantics:
 * - Current state comes from journal replay ({@link foldJournal}); the card
 *   file's frontmatter is a projection. On disagreement the journal wins and
 *   the drift is warned, never silently adopted.
 * - A structurally invalid journal fails the read loudly, naming the file and
 *   line; a card is never silently skipped.
 */
export abstract class DevflowStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'devflow')
  }

  /**
   * List the cards in the active set of one root.
   * @param filter - optional narrowing; omitted lists every card.
   * @param root - devflow root to list; omitted uses the implementation's default root.
   * @returns cards ordered by id.
   */
  abstract list(filter?: CardFilter, root?: string): Promise<DevCard[]>

  /**
   * Read one card.
   * @param id - the card id (its directory name).
   * @param root - devflow root holding the card; omitted uses the implementation's default root.
   * @returns the card with journal-derived current state.
   */
  abstract read(id: DevflowCardId, root?: string): Promise<DevCard>

  /**
   * Read one card's complete decoded journal, in revision order. The stream
   * is validated like a read: a structurally invalid journal fails loudly,
   * naming the file and line.
   * @param id - the card id (its directory name).
   * @param root - devflow root holding the card; omitted uses the implementation's default root.
   * @returns the decoded entries, oldest first.
   */
  abstract history(id: DevflowCardId, root?: string): Promise<DevflowJournalEntry[]>

  /**
   * Read the card's current lease holder.
   * @param id - the card id (its directory name).
   * @param root - devflow root holding the card; omitted uses the implementation's default root.
   * @returns the holder facts, or `undefined` while the card is unclaimed; a
   *   corrupt claim record fails loudly.
   */
  abstract holder(id: DevflowCardId, root?: string): Promise<ClaimHolder | undefined>

  /**
   * Apply implementation-owned defaults to a creation request: the slug when
   * omitted, the devflow root when omitted, and the creation timestamp.
   * @param request - the caller's request.
   * @returns the fully specified spec to hand to {@link create}.
   */
  abstract resolveCreate(request: CreateRequest): CreateSpec

  /**
   * Create one card in the active set: sequence-number allocation, the
   * exclusive card-directory creation, the journal's first `created` entry
   * (the only commit point), the projection write, then `devflow/card-created`.
   * Sequence numbers continue past archived cards, so an id is never reissued.
   * @param spec - a resolved spec from {@link resolveCreate}, never a raw request.
   * @returns the outcome; domain rejections resolve with `ok: false`.
   */
  abstract create(spec: CreateSpec): Promise<CreateResult>

  /**
   * Apply implementation-owned defaults to a transition request: the devflow
   * root when omitted and the commit timestamp.
   * @param request - the caller's request.
   * @returns the fully specified spec to hand to {@link transition}.
   */
  abstract resolve(request: TransitionRequest): TransitionSpec

  /**
   * Commit one stage move: revision check, edge check, the
   * `devflow/transition` waterfall, the journal append (the only commit
   * point), the projection rewrite, then `devflow/stage-changed`. State and
   * notifications publish only after the journal committed.
   *
   * The waterfall's gate commands put real time between those checks and the
   * append, so implementations must re-establish the checked revision at the
   * append itself, under an exclusion another process observes. A card that
   * moved in that window resolves `revision-mismatch`; a card whose commit
   * stayed excluded resolves `write-contended` with nothing written.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the outcome; domain rejections resolve with `ok: false`.
   */
  abstract transition(spec: TransitionSpec): Promise<TransitionResult>

  /**
   * Take the card's exclusive lease.
   * @param id - the card to claim.
   * @param owner - the prospective holder, recorded in the lease.
   * @param options - staleness takeover policy and root; omitted never takes
   *   over and uses the implementation's default root.
   * @returns the live handle, or the current holder when the lease is taken.
   */
  abstract claim(id: DevflowCardId, owner: DevActor, options?: ClaimOptions): Promise<ClaimResult>

  /**
   * Register a stage deliverable in the card's journal against its current
   * stage. A blocked card cannot register artifacts, and the revision check
   * mirrors {@link transition}.
   * @param request - card, artifact path, expected revision, and actor.
   * @returns the outcome; domain rejections resolve with `ok: false`.
   */
  abstract attachArtifact(request: ArtifactRequest): Promise<ArtifactResult>

  /**
   * Move every `done` card of one root out of the active set into that root's
   * archive, keyed by the month of its last journal entry. Archived cards
   * leave {@link list} but keep their complete journal.
   * @param root - devflow root to archive; omitted uses the implementation's default root.
   * @returns the archived card ids, in id order.
   */
  abstract archiveDone(root?: string): Promise<DevflowCardId[]>

  /**
   * {@link list} scoped to a viewing session's workspace, the face every
   * browser channel reads through.
   * @param filter - optional narrowing; omitted lists every card.
   * @param sessionId - the viewing session; its workspace resolves host-side
   *   to the devflow root, so the wire never carries a file path. Omitted
   *   lists the default root.
   * @returns cards ordered by id.
   */
  async listForSession(filter?: CardFilter, sessionId?: string): Promise<DevCard[]> {
    return this.list(filter, await this.sessionRoot(sessionId))
  }

  /**
   * One card's detail scoped to a viewing session's workspace: the read value,
   * its complete decoded journal, and the current lease holder in one round
   * trip.
   * @param id - the card id (its directory name).
   * @param sessionId - the viewing session; resolved like {@link listForSession}.
   * @returns the aggregated detail; `holder` is absent while the card is unclaimed.
   */
  async detailForSession(id: DevflowCardId, sessionId?: string): Promise<DevCardDetail> {
    const root = await this.sessionRoot(sessionId)
    // The card and its journal are two reads of one file; a transition landing
    // between them would tear the aggregate (revisions are contiguous from 1,
    // so the last entry's rev must equal the card's). One re-read absorbs the
    // race; a still-moving card ships its newest pair and the next forwarded
    // event refetches anyway.
    let card = await this.read(id, root)
    let entries = await this.history(id, root)
    if (entries.at(-1)?.rev !== card.stageRevision) {
      card = await this.read(id, root)
      entries = await this.history(id, root)
    }
    const holder = await this.holder(id, root)
    return { card, entries, ...holder === undefined ? {} : { holder } }
  }

  /**
   * Resolve a viewing session into its workspace devflow root: the live or
   * persisted session's header cwd maps to `<cwd>/.devflow`, and a session
   * without a cwd derives no root (the implementation default applies). The
   * browser sends only the session id — this host-side step is what keeps
   * a root off the wire the browser can choose.
   * @param sessionId - the viewing session, or `undefined` for the default root.
   * @returns the derived root, or `undefined` when none derives.
   * @throws {Error} for an unknown session, or when no session service is composed.
   */
  protected async sessionRoot(sessionId: string | undefined): Promise<string | undefined> {
    if (sessionId === undefined) return undefined
    // The wire delivers the id as a validated string; the brand is this
    // process's own session vocabulary.
    const id = sessionId as SessionId
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) return rootOfCwd(live.header.cwd)
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error(`devflow: cannot resolve session ${sessionId}: no session service is composed`)
    }
    let cwd: string | undefined
    try {
      cwd = (await persistence.inspect(id)).meta.cwd
    } catch (error) {
      throw new Error(`devflow: unknown session ${sessionId}`, { cause: error })
    }
    return rootOfCwd(cwd)
  }
}

/** The workspace's devflow root for a session cwd; no cwd derives no root. */
function rootOfCwd(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : join(cwd, '.devflow')
}

export default DevflowStore
