import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DevflowCardId } from '@zhchxiao123/dsh-devflow/client'
import type { BoardBinding } from './binding.ts'
import { inProgress, isActive } from './board.ts'
import type { DevflowArchiveSnapshot, DevflowBoardSnapshot, DevflowDetailSnapshot } from './board.ts'
import { ArchiveSection, BoardList, CardDetail } from './board-view.tsx'
import { KanbanBoard } from './kanban-view.tsx'
import { NS } from './locales.ts'
import type {} from './sidebar-right.ts'
import css from './board.module.css'

/** Full-page representations of the same read-only card set. */
type BoardViewMode = 'kanban' | 'list'

/** Everything the sidebar page renders from; the plugin binds its stores into these values. */
export interface DevflowBoardTabProps {
  /** Loading, ready, or failed board read. */
  board: DevflowBoardSnapshot
  /** The open detail, or the closed state. */
  detail: DevflowDetailSnapshot
  /** The archive, `idle` until a reader asks for it. */
  archive: DevflowArchiveSnapshot
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
  /** Show or hide the archive; showing it fetches its first page. */
  setArchiveVisible: (visible: boolean) => void
  /** Fetch the next archive page. */
  loadMoreArchive: () => void
  /** Namespace translator. */
  t: TranslateNS<typeof NS>
}

/**
 * The devflow board as a sidebar page: a full-height column whose header
 * carries the title (or the back control while a detail is open) and whose
 * body is the grouped card list or one card's detail sheet. Harness owns the
 * surrounding tab, panel sizing, dismissal, and fullscreen presentation; this
 * component only fills the official page body.
 * @param props - the listing, the detail state, the intents, and the translator.
 * @returns the page body.
 */
export function DevflowBoardTab(
  {
    board, detail, archive, splitView, openCardDetail, closeCardDetail,
    openSession, retry, setArchiveVisible, loadMoreArchive, t,
  }: DevflowBoardTabProps,
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
  const archiveShown = archive.status !== 'idle'
  const toggleArchive = (): void => { setArchiveVisible(!archiveShown) }
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
          {/* The archive is a list-view group: putting filed cards in the
              kanban would swell its done column with work nobody is doing. */}
          {viewMode === 'list'
            ? (
              <button
                type="button"
                className={css.archiveToggle}
                aria-pressed={archiveShown}
                onClick={toggleArchive}
              >
                {t('archive.toggle')}
              </button>
            )
            : null}
          <div className={css.viewToggle} role="group" aria-label={t('view.aria')}>
            <button type="button" aria-pressed={viewMode === 'kanban'} onClick={showKanban}>{t('view.kanban')}</button>
            <button type="button" aria-pressed={viewMode === 'list'} onClick={showList}>{t('view.list')}</button>
          </div>
        </div>
        {viewMode === 'kanban'
          ? <KanbanBoard cards={listing} openCardDetail={openCardDetail} t={t} />
          : (
            <>
              <BoardList cards={listing} openCardDetail={openCardDetail} t={t} />
              <ArchiveSection archive={archive} openCardDetail={openCardDetail} loadMore={loadMoreArchive} t={t} />
            </>
          )}
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
  /** Namespace translator. */
  t: TranslateNS<typeof NS>
}

/**
 * Bind the plugin's per-session bindings into an official right-Sidebar page.
 * The session-scoped slot supplies the session id and live tab information;
 * the page fetches only while its tab is visible. Fullscreen is the host's
 * explicit wide presentation, so it is also when list and detail sit side by
 * side instead of inventing a second persisted layout preference.
 * @param deps - the plugin's bindings, the watch registration, and the translator.
 * @returns the component registered as the page type's keyed body.
 */
export function createDevflowBoardPage(
  deps: DevflowBoardPageDeps,
): (props: PropsRuntime<'sidebar.right.pane.tab'>) => ReactNode {
  const { bindingFor, watch, openSession, t } = deps
  return function DevflowBoardPage({ sessionId, useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
    const binding = bindingFor(sessionId)
    const { sidebar, tab } = useTabInfo()
    useEffect(() => tab.visible ? watch(sessionId) : undefined, [sessionId, tab.visible])
    /* oxlint-disable typescript/unbound-method -- the snapshot store's members
     * are closures over its own state (see createSnapshotStore), so passing
     * them by reference carries no `this`; React needs these identities stable
     * across renders, which a wrapper here would break. */
    const board = useSyncExternalStore(binding.board.subscribe, binding.board.getSnapshot)
    const detail = useSyncExternalStore(binding.detail.subscribe, binding.detail.getSnapshot)
    const archive = useSyncExternalStore(binding.archive.subscribe, binding.archive.getSnapshot)
    /* oxlint-enable typescript/unbound-method */
    return (
      <DevflowBoardTab
        board={board}
        detail={detail}
        archive={archive}
        splitView={sidebar.fullscreen}
        openCardDetail={binding.openCardDetail}
        closeCardDetail={binding.closeCardDetail}
        openSession={openSession}
        retry={binding.refresh}
        setArchiveVisible={binding.setArchiveVisible}
        loadMoreArchive={binding.loadMoreArchive}
        t={t}
      />
    )
  }
}
