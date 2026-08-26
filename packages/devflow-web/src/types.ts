/**
 * Wire vocabulary of devflow's own browser channel. The host half serves it and
 * the browser half calls it, so both sides read these types from one place.
 * @module @zhchxiao123/dsh-devflow-web/types
 */

/**
 * The read methods the route projects, one per last path segment. The face is
 * read-only by design: card moves stay on the model tool plane, the `/devflow`
 * command plane, and the approval plane, so no write verb of the seam appears
 * here.
 */
export type DevflowWebMethod = 'list' | 'detail'

/**
 * Request body of every read call. The viewing session is the only scoping key
 * the browser can choose — the host resolves it to a devflow root, so the wire
 * carries no path in this direction.
 */
export interface DevflowWebRequest {
  /** The viewing session; omitted reads the store's default root. */
  sessionId?: string
  /** The card `detail` reads; unused by `list`. */
  id?: string
}

/**
 * Response envelope of every read call. A rejection is a settled answer, not a
 * transport failure: unknown sessions, missing cards, and unreadable journals
 * all arrive as `ok: false` with a one-line reason.
 */
export type DevflowWebResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/**
 * One push frame: a card entered the active set, or one settled at a new
 * location. The frame names the change and carries no card, because the
 * browser answers it by refetching through the read face — a payload here
 * would be a second truth racing the one the board renders.
 */
export interface DevflowChangeFrame {
  type: 'devflow/card-created' | 'devflow/stage-changed'
}
