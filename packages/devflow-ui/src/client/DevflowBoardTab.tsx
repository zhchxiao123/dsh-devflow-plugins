import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DevflowCardId } from '@zhchxiao123/dsh-devflow/client'
import type { SidebarTabProps } from './better-sidebar.ts'
import type { BoardBinding } from './binding.ts'
import { inProgress, isActive } from './board.ts'
import type { DevflowBoardSnapshot, DevflowDetailSnapshot } from './board.ts'
import { BoardList, CardDetail } from './board-view.tsx'
import { KanbanBoard } from './kanban-view.tsx'
import { NS } from './locales.ts'
import css from './board.module.css'

/** Full-page representations of the same read-only card set. */
type BoardViewMode = 'kanban' | 'list'

/** Everything the sidebar page renders from; the plugin binds its stores into these values. */
export interface DevflowBoardTabProps {
  /** Loading, ready, or failed board read. */
  board: DevflowBoardSnapshot
  /** The open detail, or the closed state. */
  detail: DevflowDetailSnapshot
  /** Show the list and an open detail side by side instead of one at a time. */
  splitView: boolean
  /** Open one card's detail. */
  openCardDetail: (id: DevflowCardId) => void
  /** Close the open detail back to the list. */
  closeCardDetail: () => void
  /** Switch the app to a timeline backlink's session. */
  openSession: (id: string) => void
  /** Retry the board read after a visible failure. */
  retry: () => Promise<void>
  /** Namespace translator. */
  t: TranslateNS<typeof NS>
}

/**
 * The devflow board as a sidebar page: a full-height column whose header
 * carries the title (or the back control while a detail is open) and whose
 * body is the grouped card list or one card's detail sheet. Unlike the
 * floating control it owns no pill, no portal, and no dismiss behavior — the
 * foundation owns the panel, so the page only fills it.
 * @param props - the listing, the detail state, the intents, and the translator.
 * @returns the page body.
 */
export function DevflowBoardTab(
  { board, detail, splitView, openCardDetail, closeCardDetail, openSession, retry, t }: DevflowBoardTabProps,
) {
  const [viewMode, setViewMode] = useState<BoardViewMode>('kanban')
  const detailOpen = detail.id !== undefined
  const listing = board.cards ?? []
  const counts = useMemo(() => ({
    active: listing.filter(inProgress).length,
    blocked: listing.filter(card => card.stage === 'blocked').length,
    done: listing.filter(card => !isActive(card)).length,
  }), [listing])
  // Side by side keeps the board in view while a card is open; stacked, the
  // detail takes the page and a back control returns to the list.
  const split = splitView && detailOpen
  const showKanban = (): void => { setViewMode('kanban') }
  const showList = (): void => { setViewMode('list') }
  const retryBoard = (): void => { void retry() }
  let list: ReactNode
  if (board.status === 'loading') {
    list = <div className={css.pageState}>{t('page.loading')}</div>
  } else if (board.status === 'error') {
    list = (
      <div className={css.pageState} role="alert">
        <span>{t('page.error')}</span>
        <button type="button" className={css.retryButton} onClick={retryBoard}>{t('page.retry')}</button>
      </div>
    )
  } else if (listing.length === 0) {
    list = <div className={css.pageState}>{t('page.empty')}</div>
  } else {
    list = (
      <div className={css.pageBody}>
        <div className={css.pageToolbar}>
          <div className={css.pageStats}>
            <span>{t('stats.total', { count: listing.length })}</span>
            <span>{t('stats.active', { count: counts.active })}</span>
            <span data-tone={counts.blocked > 0 ? 'warning' : undefined}>{t('stats.blocked', { count: counts.blocked })}</span>
            <span>{t('stats.done', { count: counts.done })}</span>
          </div>
          <div className={css.viewToggle} role="group" aria-label={t('view.aria')}>
            <button type="button" aria-pressed={viewMode === 'kanban'} onClick={showKanban}>{t('view.kanban')}</button>
            <button type="button" aria-pressed={viewMode === 'list'} onClick={showList}>{t('view.list')}</button>
          </div>
        </div>
        {viewMode === 'kanban'
          ? <KanbanBoard cards={listing} openCardDetail={openCardDetail} t={t} />
          : <BoardList cards={listing} openCardDetail={openCardDetail} t={t} />}
      </div>
    )
  }
  const sheet = (
    <div className={css.detailScroll} role="region" aria-label={t('detail.aria')}>
      {detail.card === undefined
        ? <div className={css.detailEmpty}>{t('detail.loading')}</div>
        : (
          <CardDetail
            card={detail.card}
            cards={listing}
            entries={detail.entries}
            holder={detail.holder}
            openable={detail.openableSessions}
            openCardDetail={openCardDetail}
            openSession={openSession}
            collapsible
            t={t}
          />
        )}
    </div>
  )
  return (
    <div className={css.page}>
      <header className={css.pageHeader}>
        {detailOpen && !split
          ? (
            <button
              type="button"
              className={css.detailBack}
              aria-label={t('detail.back')}
              onClick={() => { closeCardDetail() }}
            >
              ‹ {t('detail.back')}
            </button>
          )
          : <span className={css.panelTitle}>{t('panel.title')}</span>}
        {split
          ? (
            <button
              type="button"
              className={css.panelCollapse}
              aria-label={t('detail.close')}
              onClick={() => { closeCardDetail() }}
            >
              ×
            </button>
          )
          : null}
      </header>
      {split
        ? <div className={css.pageSplit}>{list}{sheet}</div>
        : detailOpen ? sheet : list}
    </div>
  )
}

/** The plugin-owned bindings and intents the sidebar page draws on. */
export interface DevflowBoardPageDeps {
  /** The board binding of one page scope; the same scope always resolves to the same binding. */
  bindingFor: (sessionId: string) => BoardBinding
  /**
   * Declare interest in one scope's board: fetches it now and keeps it
   * refetching on forwarded events until the returned disposer runs.
   */
  watch: (sessionId: string) => () => void
  /** Switch the app to a session. */
  openSession: (id: string) => void
  /**
   * The live side-by-side preference the foundation persists for this page.
   * The plugin resolves it, including what "no preference source" means
   * ({@link STACKED_ONLY}); the page only reads it.
   */
  splitView: SplitViewSource
  /** Namespace translator. */
  t: TranslateNS<typeof NS>
}

/** A live preference: subscribe for changes, read the current value. */
export interface SplitViewSource {
  /** Subscribe to preference changes. */
  subscribe: (listener: () => void) => () => void
  /** Read the current preference. */
  get: () => boolean
}

/** The preference source of a foundation that cannot carry page settings: always stacked. */
export const STACKED_ONLY: SplitViewSource = { subscribe: () => () => {}, get: () => false }

/**
 * Bind the plugin's per-session bindings into a sidebar page component. The
 * foundation renders the returned component itself, so this is where the board
 * subscribes — there is no slot renderer to synthesize hooks here. The page
 * shows its own scope's workspace and only fetches while it is the visible
 * tab of an expanded panel.
 * @param deps - the plugin's bindings, the watch registration, and the translator.
 * @returns the component to hand the foundation as the page body.
 */
export function createDevflowBoardPage(deps: DevflowBoardPageDeps): (props: SidebarTabProps) => ReactNode {
  const { bindingFor, watch, openSession, splitView: splitSource, t } = deps
  return function DevflowBoardPage({ scope, visible }: SidebarTabProps): ReactNode {
    const binding = bindingFor(scope.sessionId)
    const sessionId = scope.sessionId
    useEffect(() => visible ? watch(sessionId) : undefined, [sessionId, visible])
    const splitView = useSyncExternalStore(splitSource.subscribe, splitSource.get)
    /* oxlint-disable typescript/unbound-method -- the snapshot store's members
     * are closures over its own state (see createSnapshotStore), so passing
     * them by reference carries no `this`; React needs these identities stable
     * across renders, which a wrapper here would break. */
    const board = useSyncExternalStore(binding.board.subscribe, binding.board.getSnapshot)
    const detail = useSyncExternalStore(binding.detail.subscribe, binding.detail.getSnapshot)
    /* oxlint-enable typescript/unbound-method */
    return (
      <DevflowBoardTab
        board={board}
        detail={detail}
        splitView={splitView}
        openCardDetail={binding.openCardDetail}
        closeCardDetail={binding.closeCardDetail}
        openSession={openSession}
        retry={binding.refresh}
        t={t}
      />
    )
  }
}
