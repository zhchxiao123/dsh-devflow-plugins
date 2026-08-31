// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from './harness-doubles.ts'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevCard } from '@zhchxiao123/dsh-devflow/client'
import { DevflowBoardAction, type DevflowBoardActionProps } from '../src/client/DevflowBoardAction.tsx'
// Type-only: pulls the plugin's LocaleNamespaceMap merge into this program.
import type {} from '../src/client/index.ts'
import { createBoardSource, createDetailSource, type DevflowDetailSnapshot } from '../src/client/board.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

const t: DevflowBoardActionProps['t'] = makeTranslate(zh)

function card(over: Omit<Partial<DevCard>, 'id'> & { id: string }): DevCard {
  return {
    root: '/workspace/.devflow',
    title: `Card ${over.id}`,
    stage: 'developing',
    stageRevision: 4,
    serviceClass: 'standard',
    body: '',
    path: `tasks/${over.id}/card.md`,
    artifacts: [],
    ...over,
    id: DevflowCardId(over.id),
  }
}

function renderBoard(
  cards: DevCard[] | undefined,
  detail: Partial<DevflowDetailSnapshot> = {},
) {
  const board = createBoardSource()
  board.set({ cards })
  const detailSource = createDetailSource()
  detailSource.set({
    id: undefined, card: undefined, entries: undefined, holder: undefined, openableSessions: [], ...detail,
  })
  function useDevflowBoard<T>(select: (snapshot: { cards: DevCard[] | undefined }) => T): T {
    return select(board.getSnapshot())
  }
  function useDevflowDetail<T>(select: (snapshot: DevflowDetailSnapshot) => T): T {
    return select(detailSource.getSnapshot())
  }
  const openCardDetail = vi.fn()
  const closeCardDetail = vi.fn()
  const openSession = vi.fn()
  const props = {
    useDevflowBoard, useDevflowDetail, openCardDetail, closeCardDetail, openSession, t,
  } as unknown as DevflowBoardActionProps
  return { ...render(<DevflowBoardAction {...props} />), openCardDetail, closeCardDetail, openSession }
}

describe('DevflowBoardAction', () => {
  it('renders nothing without a fetched, non-empty board', () => {
    const empty = renderBoard(undefined)
    expect(empty.container.childElementCount).toBe(0)
    cleanup()
    const zero = renderBoard([])
    expect(zero.container.childElementCount).toBe(0)
  })

  it('shows the active count on the pill and the read-only rows in the popover', () => {
    renderBoard([
      card({ id: '0001-active', stage: 'developing', stageRevision: 4 }),
      card({ id: '0002-later', stage: 'done', stageRevision: 8 }),
      card({ id: '0004-queued', stage: 'ready', stageRevision: 3 }),
      card({ id: '0005-sketch', stage: 'draft', stageRevision: 1 }),
      card({ id: '0006-shaping', stage: 'designing', stageRevision: 2 }),
      card({ id: '0003-parked', stage: 'blocked', blockedFrom: 'reviewing', stageRevision: 6 }),
    ])
    const trigger = screen.getByRole('button', { name: '5 张研发卡进行中' })
    fireEvent.click(trigger)
    const board = screen.getByRole('list', { name: '研发流程看板' })
    const rows = board.querySelectorAll('li')
    expect(rows).toHaveLength(6)
    // Active cards first in id order; done cards settle to the tail.
    expect(rows[0].textContent).toContain('0001-active')
    expect(rows[0].textContent).toContain('开发中')
    expect(rows[0].textContent).toContain('rev 4')
    expect(rows[1].textContent).toContain('0003-parked')
    expect(rows[1].textContent).toContain('受阻')
    expect(rows[1].textContent).toContain('来自 评审')
    expect(rows[2].textContent).toContain('0004-queued')
    expect(rows[2].textContent).toContain('待开发')
    expect(rows[3].textContent).toContain('0005-sketch')
    expect(rows[3].textContent).toContain('需求草稿')
    expect(rows[4].textContent).toContain('0006-shaping')
    expect(rows[4].textContent).toContain('方案设计')
    expect(rows[5].textContent).toContain('0002-later')
    expect(rows[5].textContent).toContain('已完成')
    // Each row is exactly one detail-opening button; no other controls or inputs.
    expect(board.querySelectorAll('button')).toHaveLength(6)
    expect(board.querySelectorAll('input')).toHaveLength(0)
  })

  it('opens a card\'s detail from its row', () => {
    const { openCardDetail } = renderBoard([card({ id: '0001-a' })])
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const board = screen.getByRole('list', { name: '研发流程看板' })
    fireEvent.click(board.querySelector('li button')!)
    expect(openCardDetail).toHaveBeenCalledWith('0001-a')
  })

  it('renders the loaded detail as a read-only requirement sheet and returns to the list', () => {
    const opened = card({
      id: '0001-rich',
      title: 'Rich card',
      stage: 'blocked',
      blockedFrom: 'reviewing',
      stageRevision: 6,
      body: '## Goal\nShip it.\n\n- [ ] first check\n- [x] second check',
      artifacts: ['artifacts/design.md', 'artifacts/review.md'],
      path: '/ws/.devflow/tasks/0001-rich/card.md',
    })
    const { closeCardDetail } = renderBoard([opened], { id: opened.id, card: opened })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))

    // Detail replaces the list inside the same panel.
    expect(screen.queryByRole('list', { name: '研发流程看板' })).toBeNull()
    const detail = screen.getByRole('region', { name: '卡片详情' })
    expect(detail.textContent).toContain('Rich card')
    expect(detail.textContent).toContain('0001-rich')
    expect(detail.textContent).toContain('rev 6')
    // The Markdown body renders as a document, its checklist read-only.
    expect(screen.getByRole('heading', { name: 'Goal' })).toBeTruthy()
    const boxes = detail.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    for (const box of boxes) expect((box as HTMLInputElement).disabled).toBe(true)
    // The enlarged pipeline names every stage and marks the blocked origin.
    expect(detail.textContent).toContain('受阻')
    expect(detail.textContent).toContain('评审')
    // Artifacts and the card file path are listed.
    expect(detail.textContent).toContain('artifacts/design.md')
    expect(detail.textContent).toContain('artifacts/review.md')
    expect(detail.textContent).toContain('/ws/.devflow/tasks/0001-rich/card.md')
    // Read-only: the back control is the only button besides the collapse one.
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    expect(closeCardDetail).toHaveBeenCalled()
  })

  it('nests sub-requirements under their parent with its progress, and collapses them away', () => {
    const { openCardDetail } = renderBoard([
      card({ id: '0001-big', stage: 'designing' }),
      card({ id: '0002-slice-a', stage: 'done', parent: DevflowCardId('0001-big') }),
      card({ id: '0003-slice-b', stage: 'blocked', blockedFrom: 'developing', parent: DevflowCardId('0001-big') }),
      card({ id: '0004-standalone', stage: 'ready' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: '3 张研发卡进行中' }))
    const board = screen.getByRole('list', { name: '研发流程看板' })
    const rows = () => board.querySelectorAll('li')
    expect([...rows()].map(row => row.textContent)).toEqual([
      expect.stringContaining('0001-big'),
      expect.stringContaining('0003-slice-b'),
      expect.stringContaining('0002-slice-a'),
      expect.stringContaining('0004-standalone'),
    ])
    // The parent line reports the breakdown and flags the blocked child.
    expect(rows()[0].textContent).toContain('子需求 1/2')
    expect(rows()[0].textContent).toContain('有受阻')
    expect(rows()[3].textContent).not.toContain('子需求')
    // Only the children are indented.
    expect([...rows()].map(row => row.className.includes('rowNested'))).toEqual([false, true, true, false])

    fireEvent.click(screen.getByRole('button', { name: '收起 0001-big 的子需求' }))
    expect([...rows()].map(row => row.textContent)).toEqual([
      expect.stringContaining('0001-big'),
      expect.stringContaining('0004-standalone'),
    ])
    // The footer still counts every card, collapsed or not.
    expect(screen.getByText('4 张卡片 · 1 张已完成')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '展开 0001-big 的子需求' }))
    expect(rows()).toHaveLength(4)
    // The toggle is not an opener: each card still has exactly one.
    fireEvent.click(screen.getByRole('button', { name: '查看 0003-slice-b 详情' }))
    expect(openCardDetail).toHaveBeenCalledExactlyOnceWith('0003-slice-b')
  })

  it('reports a breakdown without a blocked child as bare progress', () => {
    renderBoard([
      card({ id: '0001-big', stage: 'designing' }),
      card({ id: '0002-slice-a', stage: 'developing', parent: DevflowCardId('0001-big') }),
    ])
    fireEvent.click(screen.getByRole('button', { name: '2 张研发卡进行中' }))
    const first = screen.getByRole('list', { name: '研发流程看板' }).querySelector('li')!
    expect(first.textContent).toContain('子需求 0/1')
    expect(first.textContent).not.toContain('有受阻')
  })

  it('promotes an orphan child whose parent left the board', () => {
    renderBoard([card({ id: '0006-orphan', parent: DevflowCardId('0099-archived') })])
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const board = screen.getByRole('list', { name: '研发流程看板' })
    expect(board.querySelectorAll('li')).toHaveLength(1)
    expect(board.querySelector('li')!.className).not.toContain('rowNested')
    expect(board.querySelectorAll('button')).toHaveLength(1)
  })

  it('drills between a requirement and its slices from the detail view', () => {
    const parent = card({ id: '0001-big', stage: 'designing', title: 'Big requirement' })
    const child = card({ id: '0002-slice-a', stage: 'done', title: 'Slice A', parent: parent.id })
    const cards = [parent, child]
    const fromParent = renderBoard(cards, { id: parent.id, card: parent })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const parentDetail = screen.getByRole('region', { name: '卡片详情' })
    expect(parentDetail.textContent).toContain('子需求 1/1')
    expect(parentDetail.textContent).toContain('Slice A')
    expect(parentDetail.textContent).not.toContain('所属需求')
    fireEvent.click(screen.getByRole('button', { name: '查看 0002-slice-a 详情' }))
    expect(fromParent.openCardDetail).toHaveBeenCalledExactlyOnceWith('0002-slice-a')
    cleanup()

    const fromChild = renderBoard(cards, { id: child.id, card: child })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const childDetail = screen.getByRole('region', { name: '卡片详情' })
    expect(childDetail.textContent).toContain('所属需求')
    expect(childDetail.textContent).toContain('Big requirement')
    fireEvent.click(screen.getByRole('button', { name: '查看 0001-big 详情' }))
    expect(fromChild.openCardDetail).toHaveBeenCalledExactlyOnceWith('0001-big')
  })

  it('shows an archived parent as a bare backlink id', () => {
    const orphan = card({ id: '0006-orphan', parent: DevflowCardId('0099-archived') })
    renderBoard([orphan], { id: orphan.id, card: orphan })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const detail = screen.getByRole('region', { name: '卡片详情' })
    expect(detail.textContent).toContain('0099-archived')
    expect(screen.queryByRole('button', { name: '查看 0099-archived 详情' })).toBeNull()
  })

  it('shows a loading placeholder while the detail fetch is in flight', () => {
    const only = card({ id: '0001-a' })
    renderBoard([only], { id: only.id, card: undefined })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    expect(screen.getByRole('region', { name: '卡片详情' }).textContent).toContain('加载中')
  })

  it('lists no artifacts with the explicit empty label and skips an empty body', () => {
    const only = card({ id: '0001-a', body: '', artifacts: [] })
    renderBoard([only], { id: only.id, card: only })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const detail = screen.getByRole('region', { name: '卡片详情' })
    expect(detail.textContent).toContain('暂无产物')
    expect(detail.querySelectorAll('input')).toHaveLength(0)
  })

  it('labels a single active card with the singular pill copy', () => {
    renderBoard([card({ id: '0001-solo' })])
    expect(screen.getByRole('button', { name: '1 张研发卡进行中' })).toBeTruthy()
  })

  it('summarizes totals in the footer and collapses through the panel header button', () => {
    renderBoard([
      card({ id: '0001-a', stage: 'developing' }),
      card({ id: '0002-b', stage: 'done' }),
    ])
    const trigger = screen.getByRole('button', { name: '1 张研发卡进行中' })
    fireEvent.click(trigger)
    expect(screen.getByText('2 张卡片 · 1 张已完成')).toBeTruthy()
    // The progress bar mirrors the seam's seven-stage pipeline; a drifted
    // mirror changes this count.
    const board = screen.getByRole('list', { name: '研发流程看板' })
    expect(board.querySelector('li')?.querySelectorAll('i')).toHaveLength(7)
    fireEvent.click(screen.getByRole('button', { name: '收起看板' }))
    expect(screen.queryByRole('list', { name: '研发流程看板' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('renders an empty warning progress run for a blocked card whose journal lost its origin stage', () => {
    // Malformed durable input: fold guarantees blockedFrom for blocked cards,
    // but the component renders whatever one fetch delivered.
    renderBoard([card({ id: '0001-lost', stage: 'blocked' })])
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const row = screen.getByRole('list', { name: '研发流程看板' }).querySelector('li')
    expect(row?.querySelectorAll('i[data-tone]')).toHaveLength(0)
  })

  it('renders the transition timeline newest-first with actors, reasons, approvals, and takeovers', () => {
    const shown = card({ id: '0001-hist', stage: 'developing', stageRevision: 5 })
    renderBoard([shown], {
      id: shown.id,
      card: shown,
      entries: [
        { rev: 1, at: '2026-08-01T00:00:00Z', type: 'created', by: { kind: 'human', name: 'byclaw' } },
        { rev: 2, at: '2026-08-02T00:00:00Z', type: 'transition', from: 'draft', to: 'designing', by: { kind: 'agent', session: 'ses-known' } },
        { rev: 3, at: '2026-08-02T12:00:00Z', type: 'artifact', stage: 'designing', path: 'artifacts/design.md', by: { kind: 'agent', session: 'ses-gone' } },
        { rev: 4, at: '2026-08-03T00:00:00Z', type: 'claim-expired', previousOwner: { kind: 'agent', session: 'ses-gone' }, by: { kind: 'command', name: 'devflow' } },
        { rev: 5, at: '2026-08-04T00:00:00Z', type: 'transition', from: 'designing', to: 'ready', by: { kind: 'human' }, reason: 'fast-tracked', gate: { approvedBy: { kind: 'human', name: 'reviewer' } } },
      ],
      holder: { owner: { kind: 'agent', session: 'ses-known' }, heartbeatAt: new Date().toISOString() },
      openableSessions: ['ses-known'],
    })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const timeline = screen.getByRole('list', { name: '流转时间线' })
    const items = timeline.querySelectorAll('li')
    expect(items).toHaveLength(5)
    // Newest first: the approved fast-track leads, creation closes the list.
    expect(items[0].textContent).toContain('方案设计')
    expect(items[0].textContent).toContain('待开发')
    expect(items[0].textContent).toContain('原因:fast-tracked')
    expect(items[0].textContent).toContain('人工审批 · 人工 reviewer')
    // The dwell anchors at the stage boundary (entering designing on 08-02),
    // so mid-stage artifact and takeover entries do not fragment it.
    expect(items[0].textContent).toContain('停留 2 天')
    expect(items[1].textContent).not.toContain('停留')
    expect(items[1].textContent).toContain('租约接管')
    expect(items[1].textContent).toContain('命令 devflow')
    expect(items[2].textContent).toContain('登记产物 artifacts/design.md')
    expect(items[4].textContent).toContain('创建')
    expect(items[4].textContent).toContain('人工 byclaw')
    // The holder and the derived summary ride the timeline header.
    const detail = screen.getByRole('region', { name: '卡片详情' })
    expect(detail.textContent).toContain('持有者 ses-known')
    expect(detail.textContent).toContain('卡龄')
    expect(detail.textContent).toContain('打回 0 次')
  })

  it('links a timeline agent to its session only while the session is known', () => {
    const shown = card({ id: '0001-links' })
    const { openSession } = renderBoard([shown], {
      id: shown.id,
      card: shown,
      entries: [
        { rev: 1, at: 't1', type: 'created', by: { kind: 'agent', session: 'ses-known' } },
        { rev: 2, at: 't2', type: 'transition', from: 'draft', to: 'designing', by: { kind: 'agent', session: 'ses-gone' } },
      ],
      holder: undefined,
      openableSessions: ['ses-known'],
    })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const link = screen.getByRole('button', { name: '打开会话 ses-known' })
    fireEvent.click(link)
    expect(openSession).toHaveBeenCalledWith('ses-known')
    // The vanished session renders as plain text, and unparseable timestamps
    // simply omit durations instead of failing the render.
    expect(screen.queryByRole('button', { name: '打开会话 ses-gone' })).toBeNull()
    const timeline = screen.getByRole('list', { name: '流转时间线' })
    expect(timeline.textContent).toContain('ses-gone')
    expect(timeline.textContent).not.toContain('停留')
  })

  it('labels anonymous actors, tolerates an empty timeline, and skips an unparseable heartbeat', () => {
    const shown = card({ id: '0001-anon' })
    renderBoard([shown], {
      id: shown.id,
      card: shown,
      entries: [
        { rev: 1, at: 't1', type: 'created', by: { kind: 'agent' } },
        { rev: 2, at: 't2', type: 'transition', from: 'draft', to: 'blocked', by: { kind: 'command' } },
      ],
      holder: { owner: { kind: 'human' }, heartbeatAt: 'not-a-time' },
      openableSessions: [],
    })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const detail = screen.getByRole('region', { name: '卡片详情' })
    expect(detail.textContent).toContain('智能体')
    expect(detail.textContent).toContain('命令')
    expect(detail.textContent).toContain('持有者 人工')
    expect(detail.textContent).not.toContain('前')

    cleanup()
    // An empty (but delivered) timeline renders its section without metrics.
    const bare = card({ id: '0001-bare' })
    renderBoard([bare], { id: bare.id, card: bare, entries: [], holder: undefined, openableSessions: [] })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const empty = screen.getByRole('region', { name: '卡片详情' })
    expect(empty.textContent).toContain('打回 0 次')
    expect(empty.textContent).not.toContain('卡龄')
  })

  it('leads a blocked card with the latest blocking reason', () => {
    const parked = card({ id: '0001-parked', stage: 'blocked', blockedFrom: 'developing' })
    renderBoard([parked], {
      id: parked.id,
      card: parked,
      entries: [
        { rev: 1, at: 't1', type: 'created', by: { kind: 'human' } },
        { rev: 2, at: 't2', type: 'transition', from: 'draft', to: 'blocked', reason: 'first stall' },
        { rev: 3, at: 't3', type: 'transition', from: 'blocked', to: 'draft' },
        { rev: 4, at: 't4', type: 'transition', from: 'draft', to: 'blocked', reason: 'awaiting upstream fix' },
      ],
      holder: undefined,
      openableSessions: [],
    })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    const detail = screen.getByRole('region', { name: '卡片详情' })
    expect(detail.textContent).toContain('受阻原因:awaiting upstream fix')
  })

  // Every edge `isReworkEdge` accepts, including the three that land on
  // `designing`. The mirrored predicate used to count only moves back to
  // `developing`, so design rework was invisible in this summary.
  it('counts rework moves in the derived summary', () => {
    const shown = card({ id: '0001-rework' })
    renderBoard([shown], {
      id: shown.id,
      card: shown,
      entries: [
        { rev: 1, at: 't1', type: 'created', by: { kind: 'human' } },
        { rev: 2, at: 't2', type: 'transition', from: 'reviewing', to: 'developing', reason: 'gaps' },
        { rev: 3, at: 't3', type: 'transition', from: 'testing', to: 'developing', reason: 'regression' },
        { rev: 4, at: 't4', type: 'transition', from: 'developing', to: 'designing', reason: 'the design cannot hold' },
        { rev: 5, at: 't5', type: 'transition', from: 'testing', to: 'designing', reason: 'acceptance disagrees' },
        { rev: 6, at: 't6', type: 'transition', from: 'designing', to: 'ready' },
      ],
      holder: undefined,
      openableSessions: [],
    })
    fireEvent.click(screen.getByRole('button', { name: '1 张研发卡进行中' }))
    expect(screen.getByRole('region', { name: '卡片详情' }).textContent).toContain('打回 4 次')
  })

  // Only a shortened pipeline earns a badge; an ordinary card must not spend
  // one saying it is ordinary.
  it('marks a shortened pipeline on the row and leaves a standard card unmarked', () => {
    renderBoard([
      card({ id: '0001-ordinary' }),
      card({ id: '0002-incident', serviceClass: 'emergency' }),
      card({ id: '0003-typo', serviceClass: 'express' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: '3 张研发卡进行中' }))
    const rows = screen.getByRole('list', { name: '研发流程看板' })
    expect(rows.textContent).toContain('紧急')
    expect(rows.textContent).toContain('快车道')
    expect(screen.getByRole('button', { name: '查看 0001-ordinary 详情' }).textContent).not.toContain('快车道')
  })

  it('labels an all-done board idle and closes on Escape', () => {
    renderBoard([card({ id: '0001-a', stage: 'done' })])
    const trigger = screen.getByRole('button', { name: '研发看板' })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    fireEvent.click(trigger)
    expect(screen.getByRole('list', { name: '研发流程看板' })).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('list', { name: '研发流程看板' })).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: '研发流程看板' })).toBeNull()
  })
})
