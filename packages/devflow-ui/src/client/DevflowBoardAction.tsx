import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDownOutline14, StateDot, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DevflowCardId } from '@zhchxiao123/dsh-devflow/client'
import { isActive } from './board.ts'
import type { DevflowBoardSource, DevflowDetailSource } from './board.ts'
import { BoardList, CardDetail } from './board-view.tsx'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './board.module.css'

/**
 * Escape closes the open panel and returns focus to the pill. Held here rather
 * than taken from `ui-primitives`, which does not export it at the harness
 * version this plugin line composes against: a shared helper is only shared
 * once it is published.
 * @param open - whether the panel is showing.
 * @param setOpen - panel state setter, invoked with false on Escape.
 * @param trigger - the pill focus returns to after the close.
 * @returns the keydown handler for the control's root.
 */
function escapeDismissHandler(
  open: boolean,
  setOpen: (open: boolean) => void,
  trigger: RefObject<HTMLButtonElement | null>,
): (event: KeyboardEvent<HTMLDivElement>) => void {
  return (event) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    trigger.current?.focus()
  }
}

/** Registration-side board seat: the plugin-owned observable snapshots plus the detail intents. */
export interface DevflowBoardInjected {
  hooks: {
    /** Current board snapshot, bound by the slot renderer. */
    devflowBoard: DevflowBoardSource
    /** Current detail snapshot, bound by the slot renderer. */
    devflowDetail: DevflowDetailSource
  }
  /** Open one card's detail: the plugin fetches it and publishes the snapshot. */
  openCardDetail(id: DevflowCardId): void
  /** Close the open detail back to the list. */
  closeCardDetail(): void
  /** Switch the app to the given session (a timeline backlink). */
  openSession(id: string): void
}

/** Full props for the floating devflow board control. */
export type DevflowBoardActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<DevflowBoardInjected>
  & PropsLocale<typeof NS>

/**
 * Floating workspace devflow board, anchored at the conversation area's
 * top-right corner through a body portal (a header ancestor's stacking
 * context must not trap it). This is the surface used where no sidebar
 * foundation is composed; the sidebar page renders the same views instead.
 *
 * Collapsed it is one pill with the active count; expanded it adds the
 * read-only panel — the grouped card list with a totals footer, swapped for
 * the clicked card's detail sheet while one is open. The back control returns
 * to the list, and closing the panel also closes the detail. It renders
 * nothing until a fetch delivered at least one card, so a workspace without
 * devflow never grows a control for a capability it is not using.
 * @param props - runtime slot currency, the board and detail stores, the
 *   detail intents, and the namespace translator.
 * @returns the floating pill and its board panel, or null when there is nothing to show.
 */
export function DevflowBoardAction(
  { useDevflowBoard, useDevflowDetail, openCardDetail, closeCardDetail, openSession, t }: DevflowBoardActionProps,
) {
  const cards = useDevflowBoard(snapshot => snapshot.cards)
  const detail = useDevflowDetail(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const activeCount = useMemo(() => (cards ?? []).filter(isActive).length, [cards])

  const setOpenAndSettleDetail = (next: boolean): void => {
    setOpen(next)
    if (!next) closeCardDetail()
  }
  useDismissOnOutsidePointer(rootRef, open, setOpenAndSettleDetail)

  if (cards === undefined || cards.length === 0) return null

  const pillLabel = activeCount > 0
    ? t(activeCount === 1 ? 'pill.active.one' : 'pill.active.other', { count: activeCount })
    : t('pill.idle')
  const doneCount = cards.length - activeCount

  const detailOpen = detail.id !== undefined

  return createPortal(
    <div ref={rootRef} className={css.root} onKeyDown={escapeDismissHandler(open, setOpenAndSettleDetail, triggerRef)}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={pillLabel}
        onClick={() => { setOpenAndSettleDetail(!open) }}
      >
        {activeCount > 0 ? <StateDot state="ongoing" className={css.triggerDot} /> : null}
        <span className={css.count}>{pillLabel}</span>
        <IconChevronDownOutline14 className={open ? css.triggerOpen : undefined} />
      </button>
      {open
        ? (
          <section className={detailOpen ? `${css.panel} ${css.panelWide}` : css.panel} aria-label={t('panel.title')}>
            <header className={css.panelHeader}>
              {detailOpen
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
              <button
                type="button"
                className={css.panelCollapse}
                aria-label={t('panel.collapse')}
                onClick={() => { setOpenAndSettleDetail(false); triggerRef.current?.focus() }}
              >
                –
              </button>
            </header>
            {detailOpen
              ? (
                <div className={css.detailScroll} role="region" aria-label={t('detail.aria')}>
                  {detail.card === undefined
                    ? <div className={css.detailEmpty}>{t('detail.loading')}</div>
                    : (
                      <CardDetail
                        card={detail.card}
                        cards={cards}
                        entries={detail.entries}
                        holder={detail.holder}
                        openable={detail.openableSessions}
                        openCardDetail={openCardDetail}
                        openSession={openSession}
                        t={t}
                      />
                    )}
                </div>
              )
              : (
                <>
                  <BoardList cards={cards} openCardDetail={openCardDetail} t={t} />
                  <footer className={css.panelFooter}>
                    <span>{t('panel.summary', { total: cards.length, done: doneCount })}</span>
                  </footer>
                </>
              )}
          </section>
        )
        : null}
    </div>,
    document.body,
  )
}
