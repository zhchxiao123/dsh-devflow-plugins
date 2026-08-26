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
  /** Gate facts attached by the transition waterfall, e.g. the human approval signature. */
  gate?: { approvedBy: DevActor }
}

/** Registration of a stage deliverable produced under `artifacts/`. */
export interface JournalArtifact {
  rev: number
  at: string
  type: 'artifact'
  path: string
  stage: DevStage
  by?: DevActor
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
  /** Artifact paths registered in the journal, in registration order. */
  artifacts: string[]
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
  }
  | { allowed: false; reason: string }

/** Stable rejection codes of {@link TransitionResult}; the discriminant is `code`. */
export type TransitionRejectionCode = 'revision-mismatch' | 'illegal-edge' | 'reason-required' | 'vetoed'

/**
 * Transition outcome. Domain rejections resolve with `ok: false` and a stable
 * code; only infrastructure failures (unwritable journal, unreadable card)
 * reject the promise.
 */
export type TransitionResult =
  | { ok: true; card: DevCard; from: CardLocation }
  | { ok: false; code: TransitionRejectionCode; message: string }

/** Caller view of one artifact registration against the card's current stage. */
export interface ArtifactRequest {
  id: DevflowCardId
  /** Artifact path relative to the card directory, e.g. `artifacts/design.md`. */
  path: string
  /** Optimistic-concurrency token: the `stageRevision` the caller last observed. */
  expectedRevision: number
  by: DevActor
  /** Devflow root holding the card; omitted uses the implementation's default root. */
  root?: string
}

/** Artifact-registration outcome; domain rejections resolve like {@link TransitionResult}. */
export type ArtifactResult =
  | { ok: true; card: DevCard }
  | { ok: false; code: 'revision-mismatch' | 'illegal-edge'; message: string }

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
