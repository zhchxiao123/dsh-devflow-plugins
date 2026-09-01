/**
 * Board source: the last Remote-fetched card list as one bare observable
 * snapshot, shared by the pill and the open panel so a refresh never tears
 * the two apart. The plugin body owns the writes; components receive the
 * renderer-bound selector hook.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClaimHolder, DevCard, DevflowCardId, DevflowJournalEntry } from '@zhchxiao123/dsh-devflow/client'

/** One board snapshot; `cards` is `undefined` before the first successful fetch or after a failed one. */
export interface DevflowBoardSnapshot {
  cards: DevCard[] | undefined
}

/**
 * Create the board's observable source.
 * @returns the snapshot source the plugin writes and the hooks compartment publishes.
 */
export function createBoardSource(): SnapshotStore<DevflowBoardSnapshot> {
  return createSnapshotStore<DevflowBoardSnapshot>({ cards: undefined })
}

/** The board source handed to the hooks compartment. */
export type DevflowBoardSource = SnapshotStore<DevflowBoardSnapshot>

/**
 * One detail snapshot: closed while `id` is `undefined`, loading while only
 * `id` is set, loaded once `card` arrived. A failed fetch closes back to the
 * list instead of holding a stale card.
 */
export interface DevflowDetailSnapshot {
  id: DevflowCardId | undefined
  card: DevCard | undefined
  /** Decoded journal entries, oldest first; `undefined` until the detail loaded. */
  entries: readonly DevflowJournalEntry[] | undefined
  /** Current lease holder; `undefined` while unclaimed or unloaded. */
  holder: ClaimHolder | undefined
  /**
   * Timeline agent-session ids that were present in the client session list
   * when the detail loaded — the clickable backlinks; a vanished session
   * renders as plain text.
   */
  openableSessions: readonly string[]
}

/** The closed detail state. */
export const CLOSED_DETAIL: DevflowDetailSnapshot = {
  id: undefined, card: undefined, entries: undefined, holder: undefined, openableSessions: [],
}

/**
 * Create the detail's observable source.
 * @returns the snapshot source the plugin writes and the hooks compartment publishes.
 */
export function createDetailSource(): SnapshotStore<DevflowDetailSnapshot> {
  return createSnapshotStore<DevflowDetailSnapshot>(CLOSED_DETAIL)
}

/** The detail source handed to the hooks compartment. */
export type DevflowDetailSource = SnapshotStore<DevflowDetailSnapshot>

/**
 * Whether a card still needs work.
 * @param card - the card to classify.
 * @returns `true` for anything not yet `done`.
 */
export function isActive(card: DevCard): boolean {
  return card.stage !== 'done'
}

/**
 * Whether a card is being worked right now. The one definition every surface
 * counts by, so a tab badge and the stats line under it can never disagree:
 * blocked cards are their own bucket, not part of this one.
 * @param card - the card to classify.
 * @returns `true` for a card that is neither `done` nor `blocked`.
 */
export function inProgress(card: DevCard): boolean {
  return card.stage !== 'done' && card.stage !== 'blocked'
}

/**
 * Board reading order: active cards first in id order, then done cards in id
 * order.
 * @param cards - the cards of one nesting level.
 * @returns a new array in reading order.
 */
export function ordered(cards: readonly DevCard[]): DevCard[] {
  return [...cards].sort((left, right) => {
    const activeLeft = isActive(left)
    if (activeLeft !== isActive(right)) return activeLeft ? -1 : 1
    return left.id.localeCompare(right.id)
  })
}

/** One board row: a card and the sub-requirements it decomposes into. */
export interface DevflowBoardRow {
  /** The row's own card. */
  card: DevCard
  /** The children to render in reading order; a narrowed row shows only some of them. */
  children: DevCard[]
  /** How many children the requirement has in total — the `n` of its `k/n` progress. */
  childTotal: number
  /** How many of those children are `done` — the `k` of its `k/n` progress. */
  doneChildren: number
  /** Whether any child sits at the `blocked` bypass. */
  blockedChildren: boolean
}

/**
 * Group one root's cards into the board's single level of nesting: every
 * top-level card followed by the children it decomposes into. A child whose
 * parent is absent from this listing (archived ahead of it) is an orphan and
 * reads as a top-level row, so no card can disappear from the board.
 * @param cards - the fetched cards of one workspace.
 * @returns the rows in reading order, each with its children in reading order.
 */
export function groupByParent(cards: readonly DevCard[]): DevflowBoardRow[] {
  const present = new Set<string>(cards.map(card => card.id))
  const isChild = (card: DevCard): boolean => card.parent !== undefined && present.has(card.parent)
  const children = new Map<string, DevCard[]>()
  for (const card of cards) {
    if (!isChild(card)) continue
    const siblings = children.get(card.parent as string) ?? []
    siblings.push(card)
    children.set(card.parent as string, siblings)
  }
  return ordered(cards.filter(card => !isChild(card))).map((card) => {
    const own = ordered(children.get(card.id) ?? [])
    return {
      card,
      children: own,
      childTotal: own.length,
      doneChildren: own.filter(child => !isActive(child)).length,
      blockedChildren: own.some(child => child.stage === 'blocked'),
    }
  })
}
