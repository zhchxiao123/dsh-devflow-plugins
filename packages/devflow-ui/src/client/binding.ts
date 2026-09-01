/**
 * One session's board data binding: the two observable snapshots plus the
 * fetches that fill them. The floating surface holds a single binding aimed at
 * whichever session is selected; the sidebar surface holds one per page scope,
 * because a sidebar page shows its own session's workspace no matter which
 * session the app has in front.
 *
 * This is also the only module that knows how board data arrives: the plugin's
 * own read-face route, served by `@zhchxiao123/dsh-devflow-web` on the same
 * origin as the app. Views, pages, and the surface chooser take values.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { DevCard, DevCardDetail, DevflowCardId } from '@zhchxiao123/dsh-devflow/client'
import type { DevflowWebMethod, DevflowWebRequest, DevflowWebResponse } from '@zhchxiao123/dsh-devflow-web/client'
import { CLOSED_DETAIL, createBoardSource, createDetailSource } from './board.ts'
import type { DevflowBoardSource, DevflowDetailSource } from './board.ts'

/** Route prefix of the read face; the host half owns the same literal. */
const READ_FACE_PREFIX = '/devflow/api'

/**
 * Call one read method. The route is served by the same host as the app, so
 * the request stays relative — there is no base to configure and no origin to
 * get wrong.
 * @param method - the read to invoke.
 * @param request - the body; the session id is the only scoping key it carries.
 * @returns the host's envelope.
 * @throws {Error} when the transport itself fails; a refused read is an `ok: false` envelope.
 */
async function callReadFace<T>(method: DevflowWebMethod, request: DevflowWebRequest): Promise<DevflowWebResponse<T>> {
  const response = await globalThis.fetch(`${READ_FACE_PREFIX}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`devflow read face ${method}: HTTP ${String(response.status)}`)
  return await response.json() as DevflowWebResponse<T>
}

/** One session's board state and the intents that move it. */
export interface BoardBinding {
  /** Board snapshot source for this session. */
  board: DevflowBoardSource
  /** Detail snapshot source for this session. */
  detail: DevflowDetailSource
  /** Open one card's detail: fetches it and publishes the snapshot. */
  openCardDetail: (id: DevflowCardId) => void
  /** Close the open detail back to the list. */
  closeCardDetail: () => void
  /** Refetch the board, and the open detail with it. */
  refresh: () => Promise<void>
}

/**
 * Create a board binding for one session.
 * @param ctx - client context carrying the sessions service, for the timeline's session backlinks.
 * @param sessionOf - the session every fetch of this binding is scoped to;
 *   read per call, so a binding aimed at "the selected session" follows it.
 * @returns the binding.
 */
export function createBoardBinding(ctx: ClientContext, sessionOf: () => string | undefined): BoardBinding {
  const board = createBoardSource()
  const detail = createDetailSource()
  /** This binding's session, folded into a request body — omitted when it has none. */
  const scoped = (request: DevflowWebRequest): DevflowWebRequest => {
    const sessionId = sessionOf()
    return sessionId === undefined ? request : { ...request, sessionId }
  }
  // Every fetch carries the epoch it belongs to, so an out-of-order
  // settlement — even for the same card id — can never clobber a newer one.
  let detailEpoch = 0
  const closeCardDetail = (): void => {
    detailEpoch += 1
    detail.set(CLOSED_DETAIL)
  }
  const loadDetail = async (id: DevflowCardId, epoch: number): Promise<void> => {
    try {
      const result = await callReadFace<DevCardDetail>('detail', scoped({ id }))
      if (epoch !== detailEpoch) return
      if (!result.ok) {
        closeCardDetail()
        return
      }
      // Timeline agents backlink only to sessions the client can open.
      const known = new Set<string>(ctx.sessions.list.getSnapshot().ids)
      const openableSessions = [...new Set(result.value.entries.flatMap((entry) => {
        const by = entry.by
        return by?.kind === 'agent' && by.session !== undefined && known.has(by.session) ? [by.session] : []
      }))]
      detail.set({
        id,
        card: result.value.card,
        entries: result.value.entries,
        holder: result.value.holder,
        openableSessions,
      })
    } catch {
      // A missing card or a transient wire failure closes back to the list.
      if (epoch === detailEpoch) closeCardDetail()
    }
  }
  const openCardDetail = (id: DevflowCardId): void => {
    detailEpoch += 1
    detail.set({ ...CLOSED_DETAIL, id })
    void loadDetail(id, detailEpoch)
  }
  const refresh = async (): Promise<void> => {
    // The open detail rides every board refresh, so an event-driven refetch
    // updates both views from the same trigger. It advances the epoch: the
    // refetch supersedes any fetch still in flight.
    const openId = detail.getSnapshot().id
    if (openId !== undefined) {
      detailEpoch += 1
      void loadDetail(openId, detailEpoch)
    }
    try {
      const result = await callReadFace<DevCard[]>('list', scoped({}))
      board.set({ cards: result.ok ? result.value : undefined })
    } catch {
      // A composition without the Host devflow service (or a transient wire
      // failure) simply shows no board; the next stage-changed retries.
      board.set({ cards: undefined })
    }
  }
  return { board, detail, openCardDetail, closeCardDetail, refresh }
}
