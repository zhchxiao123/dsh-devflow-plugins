// @vitest-environment jsdom
// The sidebar page surface: the same board and detail views the floating
// control renders, bound to the plugin's stores without any slot machinery.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from './harness-doubles.ts'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevCard } from '@zhchxiao123/dsh-devflow/client'
import { ERROR_BOARD, LOADING_BOARD, createBoardSource, createDetailSource, CLOSED_DETAIL, readyBoard } from '../src/client/board.ts'
import type { BoardBinding } from '../src/client/binding.ts'
import { createDevflowBoardPage, STACKED_ONLY } from '../src/client/DevflowBoardTab.tsx'
import type { DevflowBoardPageDeps } from '../src/client/DevflowBoardTab.tsx'
// Type-only: pulls the plugin's LocaleNamespaceMap merge into this program.
import type {} from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

const t: DevflowBoardPageDeps['t'] = makeTranslate(zh)

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
    artifactRecords: [],
    ...over,
    id: DevflowCardId(over.id),
  }
}

function renderPage(
  cards: DevCard[] | undefined,
  detail: Partial<typeof CLOSED_DETAIL> = {},
  options: { visible?: boolean; sessionId?: string; splitView?: boolean; status?: 'ready' | 'loading' | 'error' } = {},
) {
  const board = createBoardSource()
  const status = options.status ?? (cards === undefined ? 'error' : 'ready')
  if (status === 'ready') board.set(readyBoard(cards ?? []))
  else if (status === 'error') board.set(ERROR_BOARD)
  else board.set(LOADING_BOARD)
  const detailSource = createDetailSource()
  detailSource.set({ ...CLOSED_DETAIL, ...detail })
  const openCardDetail = vi.fn()
  const closeCardDetail = vi.fn()
  const openSession = vi.fn()
  const refresh = vi.fn(() => Promise.resolve())
  const binding: BoardBinding = { board, detail: detailSource, openCardDetail, closeCardDetail, refresh }
  const unwatch = vi.fn()
  const watch = vi.fn(() => unwatch)
  const scopes: string[] = []
  const Page = createDevflowBoardPage({
    bindingFor: (sessionId) => { scopes.push(sessionId); return binding },
    watch,
    openSession,
    splitView: { subscribe: () => () => {}, get: () => options.splitView === true },
    t,
  })
  const view = render(<Page scope={{ sessionId: options.sessionId ?? 'ses-one' }} visible={options.visible ?? true} />)
  return { ...view, Page, board, detailSource, openCardDetail, closeCardDetail, openSession, refresh, watch, unwatch, scopes }
}

describe('devflow sidebar page', () => {
  it('renders the stage-centric board with no pill, portal, or dismiss control', () => {
    const { openCardDetail, container } = renderPage([
      card({ id: '0001-big', stage: 'designing' }),
      card({ id: '0002-slice', stage: 'blocked', blockedFrom: 'developing', parent: DevflowCardId('0001-big') }),
    ])
    // The page fills the foundation's pane: it renders in place, not through a
    // body portal, and owns no trigger of its own.
    expect(container.querySelector('[class*="page"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /研发卡进行中/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '收起看板' })).toBeNull()

    const board = screen.getByRole('region', { name: '研发流程看板' })
    expect(board.textContent).toContain('需求草稿')
    expect(board.textContent).toContain('已完成')
    const lane = screen.getByRole('region', { name: /需求泳道/ })
    expect(lane.textContent).toContain('0001-big')
    expect(lane.textContent).toContain('0002-slice')
    expect(lane.textContent).toContain('子需求 0/1')
    expect(lane.textContent).toContain('受阻')
    fireEvent.click(screen.getByRole('button', { name: '查看 0002-slice 详情' }))
    expect(openCardDetail).toHaveBeenCalledExactlyOnceWith('0002-slice')
  })

  it('follows the store instead of a slot-synthesized snapshot', () => {
    const { board } = renderPage([card({ id: '0001-a' })])
    expect(screen.getAllByRole('button', { name: /查看 000\d/ })).toHaveLength(1)
    act(() => { board.set(readyBoard([card({ id: '0001-a' }), card({ id: '0002-b' })])) })
    expect(screen.getAllByRole('button', { name: /查看 000\d/ })).toHaveLength(2)
  })

  it('watches its own scope while visible, and lets go when it is not', () => {
    const visible = renderPage([card({ id: '0001-a' })], {}, { sessionId: 'ses-page', visible: true })
    // The page reads the binding of ITS session, not of whichever session the
    // app has in front.
    expect(visible.scopes).toEqual(['ses-page'])
    expect(visible.watch).toHaveBeenCalledExactlyOnceWith('ses-page')
    visible.unmount()
    expect(visible.unwatch).toHaveBeenCalledOnce()
    cleanup()

    const hidden = renderPage([card({ id: '0001-a' })], {}, { visible: false })
    expect(hidden.watch).not.toHaveBeenCalled()
    // Becoming visible picks the watch up exactly once.
    hidden.rerender(<hidden.Page scope={{ sessionId: 'ses-one' }} visible />)
    expect(hidden.watch).toHaveBeenCalledExactlyOnceWith('ses-one')
    hidden.rerender(<hidden.Page scope={{ sessionId: 'ses-one' }} visible />)
    expect(hidden.watch).toHaveBeenCalledOnce()
  })

  it('heads the page with the workspace total and distribution', () => {
    renderPage([
      card({ id: '0001-a', stage: 'developing' }),
      card({ id: '0002-b', stage: 'draft' }),
      card({ id: '0003-c', stage: 'blocked', blockedFrom: 'developing' }),
      card({ id: '0004-d', stage: 'done' }),
    ])
    expect(screen.getByText('共 4 张')).toBeTruthy()
    // Blocked is its own bucket, so the three counts partition the total.
    expect(screen.getByText('进行中 2')).toBeTruthy()
    expect(screen.getByText('受阻 1')).toBeTruthy()
    expect(screen.getByText('已完成 1')).toBeTruthy()
  })

  it('stays read-only: nothing but folding, filtering, and navigating', () => {
    const opened = card({ id: '0001-rich', title: 'Rich card', body: '## Goal\n- [ ] check' })
    renderPage([opened, card({ id: '0002-b' })], { id: opened.id, card: opened })
    const page = screen.getByRole('region', { name: '卡片详情' })
    // The requirement checklist renders read-only, like the floating sheet.
    const boxes = page.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(1)
    for (const box of boxes) expect((box as HTMLInputElement).disabled).toBe(true)
    expect(page.querySelectorAll('input:not([type="checkbox"]), textarea, select')).toHaveLength(0)
    // Every control on the detail is a fold or the way back.
    const controls = [...page.querySelectorAll('button, summary')]
      .map(control => control.getAttribute('aria-label') ?? control.textContent)
    expect(controls).toEqual(['需求书', '阶段产物'])
    expect(screen.getByRole('button', { name: '返回看板' })).toBeTruthy()
  })

  it('switches between Kanban and the compact list, with a narrow-stage selector available', () => {
    renderPage([
      card({ id: '0001-big', stage: 'designing' }),
      card({ id: '0002-slice-a', stage: 'blocked', blockedFrom: 'developing', parent: DevflowCardId('0001-big') }),
      card({ id: '0003-slice-b', stage: 'developing', parent: DevflowCardId('0001-big') }),
      card({ id: '0004-standalone', stage: 'done' }),
    ])
    expect(screen.getByRole('button', { name: '看板' }).getAttribute('aria-pressed')).toBe('true')
    const stageSelector = screen.getByRole('group', { name: '选择研发阶段' })
    const stageButtons = [...stageSelector.querySelectorAll('button')]
    expect(stageButtons).toHaveLength(7)
    const reviewing = stageButtons.find(button => button.textContent?.includes('评审'))!
    fireEvent.click(reviewing)
    expect(reviewing.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    const rows = screen.getByRole('list', { name: '研发流程看板' }).querySelectorAll('li')
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain('子需求 0/2')
    expect(rows[1].textContent).toContain('0002-slice-a')
    expect(rows[2].textContent).toContain('0003-slice-b')
    expect(rows[3].textContent).toContain('0004-standalone')
    fireEvent.click(screen.getByRole('button', { name: '看板' }))
    expect(screen.getByRole('region', { name: '研发流程看板' })).toBeTruthy()
  })

  it('renders the detail as foldable sections, timeline included', () => {
    const opened = card({
      id: '0001-rich',
      title: 'Rich card',
      body: '## Goal\nShip it.',
      artifacts: ['artifacts/design.md'],
      parent: DevflowCardId('0009-parent'),
    })
    renderPage([opened], {
      id: opened.id,
      card: opened,
      entries: [{ rev: 1, at: '2026-08-01T00:00:00Z', type: 'created', by: { kind: 'human' } }],
    })
    const detail = screen.getByRole('region', { name: '卡片详情' })
    const sections = [...detail.querySelectorAll('details')]
    expect(sections.map(section => section.querySelector('summary')?.textContent))
      .toEqual(['需求书', '拆分关系', '阶段产物', '流转时间线'])
    // Every section arrives open; the timeline in particular.
    for (const section of sections) expect(section.open).toBe(true)
    expect(detail.textContent).toContain('创建')
  })

  it('puts the list beside an open detail only when the preference is on', () => {
    const opened = card({ id: '0001-rich', title: 'Rich card' })
    const stacked = renderPage([opened], { id: opened.id, card: opened })
    expect(screen.queryByRole('region', { name: '研发流程看板' })).toBeNull()
    expect(screen.getByRole('button', { name: '返回看板' })).toBeTruthy()
    stacked.unmount()
    cleanup()

    const split = renderPage([opened], { id: opened.id, card: opened }, { splitView: true })
    // Both halves are on screen, and the back control gives way to a close one.
    expect(screen.getByRole('region', { name: '研发流程看板' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '卡片详情' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '返回看板' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(split.closeCardDetail).toHaveBeenCalledOnce()
  })

  it('stays stacked where the foundation cannot carry the preference', () => {
    const board = createBoardSource()
    const opened = card({ id: '0001-a' })
    board.set(readyBoard([opened]))
    const detailSource = createDetailSource()
    detailSource.set({ ...CLOSED_DETAIL, id: opened.id, card: opened })
    const binding: BoardBinding = {
      board,
      detail: detailSource,
      openCardDetail: vi.fn(),
      closeCardDetail: vi.fn(),
      refresh: vi.fn(() => Promise.resolve()),
    }
    const Page = createDevflowBoardPage({
      bindingFor: () => binding, watch: () => () => {}, openSession: vi.fn(), splitView: STACKED_ONLY, t,
    })
    render(<Page scope={{ sessionId: 'ses-one' }} visible />)
    expect(screen.getByRole('region', { name: '卡片详情' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '研发流程看板' })).toBeNull()
  })

  it('distinguishes loading, empty, and failed reads and retries the failure', () => {
    renderPage([])
    expect(screen.getByText('这个工作区还没有研发卡片。')).toBeTruthy()
    cleanup()
    renderPage(undefined, {}, { status: 'loading' })
    expect(screen.getByText('正在加载研发流程…')).toBeTruthy()
    cleanup()
    const failed = renderPage(undefined, {}, { status: 'error' })
    expect(screen.getByRole('alert').textContent).toContain('研发流程暂时无法读取。')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(failed.refresh).toHaveBeenCalledOnce()
  })

  it('shows one card\'s detail with a back control, and the loading placeholder before it lands', () => {
    const opened = card({ id: '0001-rich', title: 'Rich card', body: '## Goal\nShip it.' })
    const { closeCardDetail } = renderPage([opened], { id: opened.id, card: opened })
    const detail = screen.getByRole('region', { name: '卡片详情' })
    expect(detail.textContent).toContain('Rich card')
    expect(screen.getByRole('heading', { name: 'Goal' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '研发流程看板' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回看板' }))
    expect(closeCardDetail).toHaveBeenCalled()
    cleanup()

    renderPage([opened], { id: opened.id })
    expect(screen.getByRole('region', { name: '卡片详情' }).textContent).toContain('加载中')
    cleanup()

    // A detail can outlive its listing (a failed board fetch): the sheet still
    // renders, with no breakdown relations to resolve against.
    renderPage(undefined, { id: opened.id, card: opened })
    expect(screen.getByRole('region', { name: '卡片详情' }).textContent).toContain('Rich card')
  })
})
