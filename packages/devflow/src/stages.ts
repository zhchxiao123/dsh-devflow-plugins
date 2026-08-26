/**
 * Runtime stage vocabulary: the ordered stage list, location narrowing, and the
 * card-id factory. Kept beside the type-only module so `types.ts` stays free of
 * runtime code.
 * @module @zhchxiao123/dsh-devflow/src/stages
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CardLocation, DevStage } from './types.ts'

/** Opaque id of one task card; equals the card's directory name and never changes. */
export type DevflowCardId = Branded<'DevflowCardId'>

/** The pipeline stages in flow order; `blocked` is a bypass, not a member. */
export const DEV_STAGES = [
  'draft',
  'designing',
  'ready',
  'developing',
  'reviewing',
  'testing',
  'done',
] as const satisfies readonly DevStage[]

/**
 * Narrow an unknown value to a pipeline stage.
 * @param value - the candidate value.
 * @returns `true` when `value` is one of {@link DEV_STAGES}.
 */
export function isDevStage(value: unknown): value is DevStage {
  return typeof value === 'string' && (DEV_STAGES as readonly string[]).includes(value)
}

/**
 * Narrow an unknown value to a card location (a stage or `blocked`).
 * @param value - the candidate value.
 * @returns `true` when `value` is a stage or the `blocked` bypass.
 */
export function isCardLocation(value: unknown): value is CardLocation {
  return value === 'blocked' || isDevStage(value)
}

/**
 * Brand a raw string as a {@link DevflowCardId}. The id equals the card's
 * directory name; construction lives here because this package owns the brand.
 * @param value - the card directory name.
 * @returns the branded id.
 */
export function DevflowCardId(value: string): DevflowCardId {
  return value as DevflowCardId
}

/** Forward and rework edges of the pipeline; `blocked` legality lives in {@link isLegalTransition}. */
const FLOW: Readonly<Record<DevStage, readonly DevStage[]>> = {
  draft: ['designing'],
  designing: ['ready'],
  ready: ['developing'],
  developing: ['reviewing'],
  reviewing: ['testing', 'developing'],
  testing: ['done', 'developing'],
  done: [],
}

/**
 * Whether one stage move is a legal edge of the state machine.
 *
 * Main flow follows the pipeline order; `reviewing` and `testing` may rework
 * to `developing`; any non-terminal location may enter `blocked`; a blocked
 * card may only recover to the exact stage it interrupted.
 * @param from - the card's current location.
 * @param to - the requested target location.
 * @param blockedFrom - the remembered origin stage while `from` is `blocked`.
 * @returns `true` when the move is a legal edge.
 */
export function isLegalTransition(from: CardLocation, to: CardLocation, blockedFrom?: DevStage): boolean {
  if (from === to) return false
  if (from === 'blocked') return to === blockedFrom
  if (to === 'blocked') return from !== 'done'
  return FLOW[from].includes(to)
}

/**
 * Whether a legal edge moves the card backwards (a rework). Rework edges
 * require a recorded `reason` so the next holder knows what to fix.
 * @param from - the departing location.
 * @param to - the target location.
 * @returns `true` for `reviewing -> developing` and `testing -> developing`.
 */
export function isReworkEdge(from: CardLocation, to: CardLocation): boolean {
  return to === 'developing' && (from === 'reviewing' || from === 'testing')
}
