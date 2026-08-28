/**
 * Vocabulary types of the `ctx.devflow` capability seam: card identity, stages,
 * journal entries, and the read-side card value. Runtime helpers (stage set,
 * id factory, journal fold) live in `./journal.ts` and the package root.
 * @module @zhchxiao123/dsh-devflow/types
 */

import type {} from '@deepseek-ai/cordis'
import type { DevflowCardId } from './stages.ts'

export type { DevflowCardId } from './stages.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Single-decision transition pipeline. The store dispatches this after the
     * revision and edge checks and before the journal commit; a policy
     * listener that owns the decision returns `{ allowed: false, reason }`
     * without calling `next()`, while an observing listener must delegate.
     * @param attempt - the resolved transition about to commit, including its departure location.
     * @param next - delegate to the remaining listeners, finally `{ allowed: true }`.
     * @mode waterfall
     */
    'devflow/transition'(attempt: TransitionAttempt, next: () => Promise<TransitionDecision>): Promise<TransitionDecision>
    /**
     * A card settled at a new location after a committed transition.
     * @mode emit
     * @param card - the card after the move, `stageRevision` already advanced.
     * @param from - the location the card departed.
     */
    'devflow/stage-changed'(card: DevCard, from: CardLocation): void
    /**
     * A new card entered the active set: its journal committed the first
     * `created` entry. Dispatched once per creation, after the projection
     * write.
     * @mode emit
     * @param card - the created card, at `draft` with revision 1.
     */
    'devflow/card-created'(card: DevCard): void
  }
}

/**
 * The closed set of pipeline stages a card moves through. `blocked` is not a
 * stage: it is a bypass location that remembers the stage it interrupted (see
 * {@link CardLocation}).
 */
export type DevStage =
  | 'draft'
  | 'designing'
  | 'ready'
  | 'developing'
  | 'reviewing'
  | 'testing'
  | 'done'

/** Where a card currently sits: a pipeline stage, or the `blocked` bypass. */
export type CardLocation = DevStage | 'blocked'

/** Who performed a journal action; `command` marks the human-command intervention plane. */
export type DevActor =
  | { kind: 'human'; name?: string }
  | { kind: 'agent'; session?: string }
  | { kind: 'command'; name?: string }

/** First journal entry of every card; `rev` is always 1. */
export interface JournalCreated {
  rev: number
  at: string
  type: 'created'
  by: DevActor
  /** The card this one decomposes, fixed here at creation and never changed. */
  parent?: DevflowCardId
}

/**
 * One recorded gate verdict on a committed transition: which actor allowed the
 * move and, optionally, what the check covered. Only permitting verdicts
 * exist — a refusal vetoes the transition instead of being recorded.
 */
export interface GateCheck {
  /** The actor that allowed the move. */
  by: DevActor
  verdict: 'allowed'
  /** One-line account of what the check covered. */
  summary?: string
}

/**
 * One stage move. A move to `blocked` remembers `from`; the matching recovery
 * must return to exactly that stage.
 */
export interface JournalTransition {
  rev: number
  at: string
  type: 'transition'
  from: CardLocation
  to: CardLocation
  by?: DevActor
  reason?: string
  /**
   * Gate facts attached by the transition waterfall: the human approval
   * signature and/or the recorded gate verdicts. At least one is present —
   * a move nothing gated carries no `gate` at all.
   */
  gate?: { approvedBy?: DevActor; checks?: GateCheck[] }
}

/** Registration of a stage deliverable produced under `artifacts/`. */
export interface JournalArtifact {
  rev: number
  at: string
  type: 'artifact'
  path: string
  stage: DevStage
  by?: DevActor
  /**
   * Deliverable kind of a store-written artifact; absent for a path-only
   * registration and for entries predating kinds.
   */
  kind?: string
}

/** Takeover of a stale lease: the previous holder's heartbeat lapsed. */
export interface JournalClaimExpired {
  rev: number
  at: string
  type: 'claim-expired'
  previousOwner: DevActor
  by: DevActor
}

/** The journal entry union; the discriminant is `type`. */
export type DevflowJournalEntry = JournalCreated | JournalTransition | JournalArtifact | JournalClaimExpired

/**
 * Read-side value of one artifact registration: the journal entry's facts
 * without its envelope. Registrations are immutable — the newest record of one
 * `kind` (the highest `rev`) is that kind's current content.
 */
export interface ArtifactRecord {
  /** Artifact path relative to the card directory. */
  path: string
  /** Deliverable kind; absent for a path-only registration. */
  kind?: string
  /** Journal revision of the registration; orders records of one kind. */
  rev: number
  /** The stage the deliverable was registered against. */
  stage: DevStage
}

/** Read-side value of one card, current state derived by journal replay. */
export interface DevCard {
  id: DevflowCardId
  /** Resolved devflow root directory this card belongs to (absolute path). */
  root: string
  /** Human title from the card file's frontmatter. */
  title: string
  /** Current location derived from the journal, never from the frontmatter projection. */
  stage: CardLocation
  /** Revision of the last journal entry; optimistic-concurrency token for transitions. */
  stageRevision: number
  /** The stage a `blocked` card returns to on recovery; absent unless `stage` is `blocked`. */
  blockedFrom?: DevStage
  /**
   * The card this one decomposes; absent for a top-level card. Only one level
   * exists, so a card carrying `parent` is never itself a parent.
   */
  parent?: DevflowCardId
  /** Markdown body of the card file below its frontmatter. */
  body: string
  /** Display path of the card file. */
  path: string
  /** Artifact paths registered in the journal, in registration order; the path projection of {@link artifactRecords}. */
  artifacts: string[]
  /** Artifact registrations in registration order, each carrying its journal revision, registering stage, and optional kind. */
  artifactRecords: ArtifactRecord[]
}

/** Read filter accepted by {@link import('./index.ts').DevflowStore.list}. */
export interface CardFilter {
  /** Only cards currently at this location. */
  stage?: CardLocation
  /** Only cards decomposing this one; an id with no children matches nothing. */
  parent?: DevflowCardId
}

/** Caller view of one card creation; `resolveCreate` turns it into a {@link CreateSpec}. */
export interface CreateRequest {
  /** Human title recorded in the card file's frontmatter. */
  title: string
  /** Markdown body below the frontmatter: the requirement and its acceptance criteria. */
  body: string
  /** Directory-name slug; omitted derives one from the title. */
  slug?: string
  /** Who creates the card; recorded in the journal's first entry. */
  by: DevActor
  /**
   * The card this one decomposes; omitted creates a top-level card. The parent
   * must be an active top-level card of the same root — only one level exists.
   */
  parent?: DevflowCardId
  /** Devflow root receiving the card; omitted uses the implementation's default root. */
  root?: string
}

/** Fully specified creation input produced by `resolveCreate`, never a raw request. */
export interface CreateSpec extends CreateRequest {
  /** The resolved directory-name slug. */
  slug: string
  /** Creation timestamp stamped at resolution. */
  at: string
  /** The resolved devflow root (absolute path). */
  root: string
}

/**
 * Stable rejection codes of {@link CreateResult}; the discriminant is `code`.
 * The parent codes name the three illegal edges: no such card in this root,
 * a parent that is itself a child, and a parent past taking new work.
 */
export type CreateRejectionCode =
  | 'empty-title'
  | 'invalid-slug'
  | 'exists'
  | 'unknown-parent'
  | 'nested-parent'
  | 'parent-settled'

/**
 * Creation outcome. Domain rejections resolve with `ok: false` and a stable
 * code; only infrastructure failures (unwritable root, unreadable directory
 * listing) reject the promise.
 */
export type CreateResult =
  | { ok: true; card: DevCard }
  | { ok: false; code: CreateRejectionCode; message: string }

/** Caller view of one intended stage move; `resolve` turns it into a {@link TransitionSpec}. */
export interface TransitionRequest {
  id: DevflowCardId
  /** Target location; legality is checked against the card's current location. */
  to: CardLocation
  /** Optimistic-concurrency token: the `stageRevision` the caller last observed. */
  expectedRevision: number
  /** Who requests the move; recorded in the journal on commit. */
  by: DevActor
  /** Move rationale; recorded in the journal when present. */
  reason?: string
  /** Devflow root holding the card; omitted uses the implementation's default root. */
  root?: string
}

/** Fully specified transition input produced by `resolve`, never a raw request. */
export interface TransitionSpec extends TransitionRequest {
  /** Commit timestamp stamped at resolution. */
  at: string
  /** The resolved devflow root (absolute path). */
  root: string
}

/**
 * The complete attempt the `devflow/transition` waterfall decides on: the
 * resolved spec plus the departure location the store derived from the
 * journal. Policy listeners key gate rules on the `from -> to` edge.
 */
export interface TransitionAttempt extends TransitionSpec {
  from: CardLocation
}

/** Decision value of the `devflow/transition` waterfall; not calling `next()` vetoes. */
export type TransitionDecision =
  | {
    allowed: true
    /** The human signature a policy listener collected; recorded as the journal entry's `gate.approvedBy`. */
    approvedBy?: DevActor
    /** Gate verdicts policy listeners collected; recorded as the journal entry's `gate.checks` when non-empty. */
    checks?: GateCheck[]
  }
  | { allowed: false; reason: string }

/**
 * Stable rejection codes of {@link TransitionResult}; the discriminant is
 * `code`. `write-contended` is the only one a caller can retry unchanged: it
 * says another process held the card's commit long enough that this one gave
 * up, and that nothing was written.
 */
export type TransitionRejectionCode =
  | 'revision-mismatch'
  | 'illegal-edge'
  | 'reason-required'
  | 'vetoed'
  | 'write-contended'

/**
 * Transition outcome. Domain rejections resolve with `ok: false` and a stable
 * code; only infrastructure failures (unwritable journal, unreadable card)
 * reject the promise.
 */
export type TransitionResult =
  | { ok: true; card: DevCard; from: CardLocation }
  | { ok: false; code: TransitionRejectionCode; message: string }

/** Fields shared by both {@link ArtifactRequest} forms. */
interface ArtifactRequestBase {
  id: DevflowCardId
  /** Optimistic-concurrency token: the `stageRevision` the caller last observed. */
  expectedRevision: number
  by: DevActor
  /** Devflow root holding the card; omitted uses the implementation's default root. */
  root?: string
}

/** Reference form: the caller already wrote the file and registers its path. */
export interface ArtifactPathRequest extends ArtifactRequestBase {
  /** Artifact path relative to the card directory, e.g. `artifacts/design.md`. */
  path: string
}

/**
 * Store-written form: the implementation writes `artifacts/<rev>-<kind>.md`
 * itself, before the journal append, and registers that path.
 */
export interface ArtifactContentRequest extends ArtifactRequestBase {
  /** Deliverable kind; the slug grammar, rejected `invalid-kind` otherwise. */
  kind: string
  /** Complete Markdown content the implementation writes. */
  content: string
}

/**
 * Caller view of one artifact registration against the card's current stage:
 * the reference form or the store-written form. The two are mutually
 * exclusive — the model-facing tool rejects a call carrying both before the
 * seam is reached.
 */
export type ArtifactRequest = ArtifactPathRequest | ArtifactContentRequest

/** Artifact-registration outcome; domain rejections resolve like {@link TransitionResult}. */
export type ArtifactResult =
  | { ok: true; card: DevCard; record: ArtifactRecord }
  | { ok: false; code: 'revision-mismatch' | 'illegal-edge' | 'invalid-kind' | 'write-contended'; message: string }

/** Current lease facts of one card, read from its claim record. */
export interface ClaimHolder {
  /** The lease's recorded owner. */
  owner: DevActor
  /** The owner's last liveness mark (ISO timestamp; empty when the record carries none). */
  heartbeatAt: string
}

/**
 * Aggregated Remote detail of one card: the read value, its complete decoded
 * journal in revision order, and the current lease holder (absent while
 * unclaimed).
 */
export interface DevCardDetail {
  /** The card's read value, consistent with `entries` (same last revision). */
  card: DevCard
  /** The complete decoded journal, oldest first. */
  entries: DevflowJournalEntry[]
  /** The current lease holder; absent while the card is unclaimed. */
  holder?: ClaimHolder
}

/** Options accepted by {@link import('./index.ts').DevflowStore.claim}. */
export interface ClaimOptions {
  /**
   * Take over a held lease whose last heartbeat is older than this many
   * milliseconds; the takeover is journaled as a `claim-expired` entry.
   * Omitted means a held lease is never taken over.
   */
  staleAfterMs?: number
  /** Devflow root holding the card; omitted uses the implementation's default root. */
  root?: string
}

/** Claim outcome; a held lease resolves with the current holder instead of rejecting. */
export type ClaimResult =
  | { ok: true; handle: ClaimHandle }
  | { ok: false; holder: DevActor; message: string }

/** Live lease on one card, exclusive until released. */
export interface ClaimHandle {
  id: DevflowCardId
  owner: DevActor
  /** Refresh the lease's liveness mark. */
  heartbeat(): Promise<void>
  /** Release the lease; releasing twice is a no-op. */
  release(): Promise<void>
}
