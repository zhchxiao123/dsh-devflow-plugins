// @vitest-environment jsdom
/**
 * ui-devflow plugin halves: the browser entry's surface choice (floating
 * control or sidebar page, never both) against the real SlotRegistry and a
 * stubbed sidebar foundation, with fiber teardown proving removal — HMR
 * safety — plus the Remote fetch wiring, the inert node entry, and
 * the invariant companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from './harness-doubles.ts'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, BOARD_TAB_ID, inject } from '../src/client/index.ts'
import type { DevflowBoardInjected } from '../src/client/index.ts'
import { BETTER_SIDEBAR } from '../src/client/better-sidebar.ts'
import type { BetterSidebarService, SidebarTabDescriptor } from '../src/client/better-sidebar.ts'
import { apply as applyNode } from '../src/index.ts'
import * as DevflowInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Slot ledger reader: entry ids currently registered in the header utility list. */
function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.header.utilities')
    .map(entry => entry.options.id)
}

/**
 * Drain the microtask queue. A board fetch settles over several of them (the
 * request, then the JSON body), so a fixed count of `await Promise.resolve()`
 * would tie these assertions to the transport's internal step count.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** One read-face answer, as the route's transport delivers it. */
function jsonResponse(envelope: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(envelope) } as Response
}

/** A change-stream socket the test drives in the host's place. */
class StubSocket {
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>()
  closed = false

  constructor(readonly url: URL) {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers.set(type, [...this.handlers.get(type) ?? [], handler])
  }

  close(): void {
    this.closed = true
    this.deliver('close', {})
  }

  /** Fire one event at whatever the plugin registered for it. */
  deliver(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event)
  }
}

interface Bench {
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  listCalls: number
  /** The session id in the body of each list fetch, in call order. */
  listSessions: (string | undefined)[]
  /** The (card id, session id) body pairs of each detail fetch. */
  readCalls: [string, string | undefined][]
  /** The (url, raw body) pair of every read-face request, in call order. */
  requests: [string, string][]
  /** Change-stream sockets the plugin opened, in order. */
  sockets: StubSocket[]
  /** Deliver `open` on the newest socket, as the host would on accepting it. */
  openStream: () => void
  /** Deliver one change frame on the newest socket. */
  pushFrame: (type: string) => void
  /** Deliver one frame of each type, the two a card move and a creation send. */
  pushFrames: () => void
  /** Session ids the plugin asked the client sessions service to open. */
  openedSessions: string[]
  /** Subscribers of the stubbed client sessions list store. */
  sessionSubscribers: (() => void)[]
  setCurrentSession: (id: string | undefined) => void
  /** Sidebar pages the plugin registered on the stubbed foundation, in order. */
  registeredTabs: SidebarTabDescriptor[]
  /** Page ids whose registration disposer the plugin called. */
  unregisteredTabs: string[]
}

/**
 * A stand-in for the `dsh-better-sidebar` foundation: it lives outside this
 * workspace, so the composition test stubs the service the plugin talks to and
 * records what lands on it.
 */
function sidebarStub(
  state: Bench,
  features?: readonly string[],
  pluginSettings?: Record<string, unknown>,
): BetterSidebarService {
  return {
    registerTab: (descriptor) => {
      state.registeredTabs.push(descriptor)
      return () => { state.unregisteredTabs.push(descriptor.id) }
    },
    ...features === undefined ? {} : { features },
    ...pluginSettings === undefined
      ? {}
      : {
        getSnapshot: () => ({ prefs: { pluginSettings: { [BOARD_TAB_ID]: pluginSettings } } }),
        subscribeState: () => () => {},
      },
  }
}

/** Render the registered sidebar page for one scope, as the foundation would. */
function renderPage(state: Bench, sessionId: string, visible = true) {
  const descriptor = state.registeredTabs.at(-1)
  if (descriptor === undefined) throw new Error('no sidebar page was registered')
  const Page = descriptor.component
  return render(<Page scope={{ sessionId }} visible={visible} />)
}

/**
 * Boot the browser half over a real slot tree and a scripted Remote devflow
 * namespace.
 * @param listResult - the scripted board fetch result.
 * @param options - `sidebar` composes the stubbed foundation before activation.
 * @returns the bench state.
 */
async function bench(
  listResult: () => unknown,
  options: { sidebar?: boolean; features?: readonly string[]; pluginSettings?: Record<string, unknown> } = {},
): Promise<Bench> {
  const ctx = new Context()
  let current: string | undefined = 'ses-one'
  const state: Bench = {
    ctx,
    fiber: undefined as never,
    listCalls: 0,
    listSessions: [],
    readCalls: [],
    requests: [],
    sockets: [],
    openStream: () => { state.sockets.at(-1)!.deliver('open', {}) },
    pushFrame: (type) => { state.sockets.at(-1)!.deliver('message', { data: JSON.stringify({ type }) }) },
    pushFrames: () => {
      state.pushFrame('devflow/stage-changed')
      state.pushFrame('devflow/card-created')
    },
    openedSessions: [],
    sessionSubscribers: [],
    setCurrentSession: (id) => {
      current = id
      for (const notify of state.sessionSubscribers) notify()
    },
    registeredTabs: [],
    unregisteredTabs: [],
  }
  if (options.sidebar === true) ctx.provide(BETTER_SIDEBAR, sidebarStub(state, options.features, options.pluginSettings))
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({ current, ids: ['ses-known'] }),
      subscribe: (listener: () => void) => {
        state.sessionSubscribers.push(listener)
        return () => {
          const index = state.sessionSubscribers.indexOf(listener)
          if (index >= 0) state.sessionSubscribers.splice(index, 1)
        }
      },
    },
    open: (id: string) => { state.openedSessions.push(id) },
  } as never)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  // The board's own read-face route, stubbed at the transport: every board
  // fetch is one POST whose body carries the viewing session and nothing else.
  vi.stubGlobal('fetch', (input: string, init: { body: string }) => {
    state.requests.push([input, init.body])
    const { sessionId, id } = JSON.parse(init.body) as { sessionId?: string; id?: string }
    if (input === '/devflow/api/list') {
      state.listCalls += 1
      state.listSessions.push(sessionId)
      return Promise.resolve(jsonResponse(listResult()))
    }
    state.readCalls.push([id!, sessionId])
    return Promise.resolve(jsonResponse({
      ok: true,
      value: {
        card: {
          id,
          root: '/ws/.devflow',
          title: `Card ${String(id)}`,
          stage: 'developing',
          stageRevision: 4,
          body: '',
          path: `tasks/${String(id)}/card.md`,
          artifacts: [],
        },
        entries: [
          { rev: 1, at: 't1', type: 'created', by: { kind: 'agent', session: 'ses-known' } },
          { rev: 2, at: 't2', type: 'transition', from: 'draft', to: 'designing', by: { kind: 'agent', session: 'ses-gone' } },
        ],
        holder: { owner: { kind: 'human' }, heartbeatAt: 't2' },
      },
    }))
  })
  // The real locale plugin below still binds `ctx.remote`; the board no longer
  // does, which is what the inject assertion pins.
  ctx.provide('remote', { $on: () => () => {} } as never)
  // The plugin's own change stream: the test plays the host, deciding when the
  // socket opens, what it announces, and when it drops.
  vi.stubGlobal('WebSocket', class extends StubSocket {
    constructor(url: URL) {
      super(url)
      state.sockets.push(this)
    }
  })
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  ctx.locale.setLocale('zh')
  state.fiber = ctx.plugin({ inject: [...inject], apply })
  await state.fiber.await()
  return state
}

afterEach(() => {
  cleanup()
})

describe('ui-devflow browser half', () => {
  it('declares the services it binds — board data needs none of them', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale'])
  })

  it('registers the header action, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench(() => ({ ok: true, value: [] }))
    expect(headerEntryIds(ctx)).toContain('devflow-board')
    // The registration-side seat hands the renderer the plugin-owned board store.
    const entry = ctx.slots
      .entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'devflow-board')
    const seat = (entry?.inject as (() => DevflowBoardInjected) | undefined)?.()
    expect(seat?.hooks.devflowBoard.getSnapshot()).toEqual({ cards: [] })
    await fiber.dispose()
    expect(headerEntryIds(ctx)).not.toContain('devflow-board')
  })

  it('registers the sidebar page instead of the header action where the foundation is composed', async () => {
    const state = await bench(() => ({ ok: true, value: [] }), { sidebar: true })
    expect(headerEntryIds(state.ctx)).not.toContain('devflow-board')
    expect(state.registeredTabs).toHaveLength(1)
    const page = state.registeredTabs[0]
    expect(page).toMatchObject({ id: BOARD_TAB_ID, order: 60, single: true })
    // A function title re-reads the dictionary, so a locale switch follows.
    expect(typeof page.title === 'function' ? page.title() : page.title).toBe('研发流程')
    state.ctx.locale.setLocale('en')
    expect(typeof page.title === 'function' ? page.title() : page.title).toBe('Devflow')

    await state.fiber.dispose()
    expect(state.unregisteredTabs).toEqual([BOARD_TAB_ID])
  })

  it('swaps surfaces when the foundation arrives and leaves, never showing both', async () => {
    const state = await bench(() => ({ ok: true, value: [] }))
    expect(headerEntryIds(state.ctx)).toContain('devflow-board')
    expect(state.registeredTabs).toHaveLength(0)

    const dispose = state.ctx.provide(BETTER_SIDEBAR, sidebarStub(state))
    await state.fiber.await()
    expect(state.registeredTabs).toHaveLength(1)
    expect(headerEntryIds(state.ctx)).not.toContain('devflow-board')

    // The disposer notifies synchronously before it settles its own fibers.
    dispose()
    await state.fiber.await()
    expect(state.unregisteredTabs).toEqual([BOARD_TAB_ID])
    expect(headerEntryIds(state.ctx)).toContain('devflow-board')
  })

  it('reaches the board over its own read-face route, sending only a session id', async () => {
    const state = await bench(() => ({ ok: true, value: [] }))
    const entry = state.ctx.slots
      .entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'devflow-board')
    const seat = (entry?.inject as (() => DevflowBoardInjected) | undefined)?.()
    seat!.openCardDetail('0001-a' as never)
    await flush()

    expect(state.requests.map(([url]) => url)).toEqual([
      '/devflow/api/list',
      '/devflow/api/detail',
    ])
    // The board never asks for a root, a cwd, or any other path: the host
    // derives one from the session, which is the only key that travels.
    expect(state.requests.map(([, body]) => JSON.parse(body) as unknown)).toEqual([
      { sessionId: 'ses-one' },
      { id: '0001-a', sessionId: 'ses-one' },
    ])
    // A workspace with no selected session reads the store's default root.
    state.setCurrentSession(undefined)
    await flush()
    expect(JSON.parse(state.requests.at(-1)![1]) as unknown).toEqual({})

    // A composition without the route answers 404, and a transport failure is
    // not an envelope: the board renders as absent until the next event.
    const seatBoard = seat!.hooks.devflowBoard
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 404 } as Response))
    state.pushFrame('devflow/stage-changed')
    await flush()
    expect(seatBoard.getSnapshot()).toEqual({ cards: undefined })
  })

  it('fetches per page scope: the selected session and whatever a visible page watches', async () => {
    const state = await bench(() => ({ ok: true, value: [] }), { sidebar: true })
    // Registration alone fetches once, for the selected session: the tab badge
    // and the `+` menu need something to report before the page is opened.
    expect(state.listSessions).toEqual(['ses-one'])

    const hidden = renderPage(state, 'ses-page', false)
    expect(state.listSessions).toEqual(['ses-one'])
    // A page that is not the visible tab costs nothing of its own: the events
    // below refresh only the session the user has selected.
    state.pushFrames()
    expect(state.listSessions).toEqual(['ses-one', 'ses-one', 'ses-one'])
    hidden.unmount()

    // Becoming visible fetches ITS scope, and stays live on forwarded events.
    renderPage(state, 'ses-page')
    expect(state.listSessions.slice(3)).toEqual(['ses-page'])
    state.pushFrames()
    expect(state.listSessions.slice(4).sort()).toEqual(['ses-one', 'ses-one', 'ses-page', 'ses-page'])
    cleanup()

    // With the page gone, its scope stops following events; the selected
    // session keeps its badge live.
    state.pushFrames()
    expect(state.listSessions.slice(8)).toEqual(['ses-one', 'ses-one'])
  })

  it('follows a real selection change and every change-stream open', async () => {
    const state = await bench(() => ({ ok: true, value: [] }), { sidebar: true })
    expect(state.listSessions).toEqual(['ses-one'])
    // A newly selected session needs its board for the badge and the `+` menu;
    // a host without any selection still has the store's configured root.
    state.setCurrentSession(undefined)
    expect(state.listSessions).toEqual(['ses-one', undefined])
    // The list store publishes far more often than the selection moves.
    for (const notify of state.sessionSubscribers) notify()
    expect(state.listSessions).toEqual(['ses-one', undefined])
    state.openStream()
    expect(state.listSessions).toEqual(['ses-one', undefined, undefined])
  })

  it('reports a badge only where the foundation announces the capability', async () => {
    const plain = await bench(() => ({ ok: true, value: [] }), { sidebar: true })
    expect(plain.registeredTabs[0].badge).toBeUndefined()
    await plain.fiber.dispose()

    const state = await bench(
      () => ({ ok: true, value: [{ id: '0001-a', stage: 'developing' }, { id: '0002-b', stage: 'done' }] }),
      { sidebar: true, features: ['badge'] },
    )
    const page = state.registeredTabs[0]
    renderPage(state, 'ses-one')
    // The count comes from the last fetch, so the badge costs no request.
    const before = state.listCalls
    expect(page.badge?.(undefined, { sessionId: 'ses-one' }, undefined)).toBe(1)
    expect(state.listCalls).toBe(before)
    // A scope nothing fetched has nothing to report.
    expect(page.badge?.(undefined, { sessionId: 'ses-elsewhere' }, undefined)).toBeUndefined()
  })

  it('offers the page as unavailable only for a workspace known to hold no cards', async () => {
    const empty = await bench(() => ({ ok: true, value: [] }), { sidebar: true })
    const emptyPage = empty.registeredTabs[0]
    expect(emptyPage.available?.(undefined, { sessionId: 'ses-one' }, undefined)).toBe(false)
    // An unfetched scope stays openable — opening it is what fetches.
    expect(emptyPage.available?.(undefined, { sessionId: 'ses-unknown' }, undefined)).toBe(true)
    await empty.fiber.dispose()

    const state = await bench(() => ({ ok: true, value: [{ id: '0001-a', stage: 'draft' }] }), { sidebar: true })
    expect(state.registeredTabs[0].available?.(undefined, { sessionId: 'ses-one' }, undefined)).toBe(true)
  })

  it('offers the side-by-side setting only where the foundation can persist and republish it', async () => {
    const plain = await bench(() => ({ ok: true, value: [] }), { sidebar: true, features: ['badge'] })
    expect(plain.registeredTabs[0].settings).toBeUndefined()
    await plain.fiber.dispose()

    const state = await bench(
      () => ({ ok: true, value: [{ id: '0001-a', stage: 'draft', title: 'Card', body: '', artifacts: [], path: 'p', root: 'r', stageRevision: 1 }] }),
      { sidebar: true, features: ['pluginSettings', 'stateSubscription'], pluginSettings: { splitView: true } },
    )
    const page = state.registeredTabs[0]
    const toggle = page.settings?.pluginToggles?.[0]
    expect(toggle?.key).toBe('splitView')
    expect(typeof toggle?.title === 'function' ? toggle.title() : toggle?.title).toBe('列表与详情并列')
    expect(typeof toggle?.desc === 'function' ? toggle.desc() : toggle?.desc).toContain('面板足够宽时')

    // The page reads the persisted value: list and detail render together.
    renderPage(state, 'ses-one')
    await vi.waitFor(() => {
      expect(screen.getByRole('list', { name: '研发流程看板' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '查看 0001-a 详情' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('region', { name: '卡片详情' })).toBeTruthy()
    })
    expect(screen.getByRole('list', { name: '研发流程看板' })).toBeTruthy()
  })

  it('warns and keeps working when the foundation refuses the page', async () => {
    const state = await bench(() => ({ ok: true, value: [] }))
    const warn = vi.spyOn(state.ctx.logger, 'warn').mockImplementation(() => {})
    state.ctx.provide(BETTER_SIDEBAR, {
      registerTab: () => { throw new Error('tab type "dsh-devflow:board" already registered') },
    } satisfies BetterSidebarService)
    await state.fiber.await()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already registered'))
    // The plugin stays alive: its dictionaries and its fetch wiring are intact.
    expect(state.ctx.locale.bind(NS)('panel.title')).toBe('研发流程')
    state.pushFrames()
    expect(state.listCalls).toBeGreaterThan(1)
    await state.fiber.dispose()
  })

  it('ignores service notifications that change nothing', async () => {
    const state = await bench(() => ({ ok: true, value: [] }))
    expect(headerEntryIds(state.ctx)).toContain('devflow-board')
    // Another service coming and going is none of the board's business, and a
    // repeated notification for an unchanged foundation must not churn the
    // mounted surface.
    state.ctx.emit('internal/service', 'unrelated', undefined)
    state.ctx.emit('internal/service', BETTER_SIDEBAR, undefined)
    expect(headerEntryIds(state.ctx)).toContain('devflow-board')
    expect(state.registeredTabs).toHaveLength(0)
  })

  it('fetches at activation, on every change-stream open, and per change frame', async () => {
    const state = await bench(() => ({ ok: true, value: [] }))
    expect(state.listCalls).toBe(1)
    // The stream is the plugin's own endpoint, same origin as the app.
    expect(state.sockets.map(socket => socket.url.pathname)).toEqual(['/devflow/ws'])
    expect(state.sockets[0].url.protocol).toBe('ws:')
    expect(state.sockets[0].url.host).toBe(globalThis.location.host)

    // An open refetches: a board that was down while cards moved has no other
    // way to learn what it missed.
    state.openStream()
    expect(state.listCalls).toBe(2)
    state.pushFrames()
    expect(state.listCalls).toBe(4)
    // A frame this client does not know changes nothing.
    state.pushFrame('devflow/something-else')
    state.sockets.at(-1)!.deliver('message', { data: 'not json' })
    state.sockets.at(-1)!.deliver('message', { data: new ArrayBuffer(4) })
    expect(state.listCalls).toBe(4)
    // Every fetch is scoped to the currently selected session.
    expect(state.listSessions).toEqual(['ses-one', 'ses-one', 'ses-one', 'ses-one'])

    await state.fiber.dispose()
    expect(state.sockets[0].closed).toBe(true)
  })

  it('follows the page into TLS', async () => {
    vi.stubGlobal('location', { href: 'https://harness.internal/app', host: 'harness.internal' })
    const state = await bench(() => ({ ok: true, value: [] }))
    expect(state.sockets[0].url.href).toBe('wss://harness.internal/devflow/ws')
    await state.fiber.dispose()
  })

  it('reopens a dropped change stream, and stops once disposed', async () => {
    vi.useFakeTimers()
    try {
      const state = await bench(() => ({ ok: true, value: [] }))
      expect(state.sockets).toHaveLength(1)

      // A host restart or a network blip drops the socket; the board does not
      // stay dark until the next reload.
      state.sockets[0].close()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(state.sockets).toHaveLength(2)

      // A host that stays down is retried ever more slowly, so a long outage
      // does not become a reconnect loop.
      state.sockets[1].close()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(state.sockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(state.sockets).toHaveLength(3)

      // Coming back resets the wait, so the next blip costs the floor again.
      state.openStream()
      expect(state.listCalls).toBe(2)
      state.sockets[2].close()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(state.sockets).toHaveLength(4)

      // Disposal cancels a reopen already scheduled.
      state.sockets[3].close()
      await state.fiber.dispose()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(state.sockets).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refetches the board for the newly selected session, and only on a real selection change', async () => {
    const state = await bench(() => ({ ok: true, value: [] }))
    expect(state.listSessions).toEqual(['ses-one'])
    state.setCurrentSession('ses-two')
    expect(state.listSessions).toEqual(['ses-one', 'ses-two'])
    // A list-store publish without a selection change does not refetch.
    for (const notify of state.sessionSubscribers) notify()
    expect(state.listCalls).toBe(2)
    // Clearing the selection refetches the default board.
    state.setCurrentSession(undefined)
    expect(state.listSessions).toEqual(['ses-one', 'ses-two', undefined])
    await state.fiber.dispose()
    state.setCurrentSession('ses-three')
    expect(state.listCalls).toBe(3)
  })

  it('contains a failed or rejected fetch instead of breaking activation', async () => {
    let mode: 'error' | 'throw' = 'error'
    const state = await bench(() => {
      if (mode === 'throw') throw new Error('wire down')
      return { ok: false, error: { code: 'internal', message: 'absent' } }
    })
    expect(state.listCalls).toBe(1)
    mode = 'throw'
    state.pushFrame('devflow/stage-changed')
    expect(state.listCalls).toBe(2)
    await state.fiber.dispose()
  })

  it('fetches an opened detail session-scoped, refreshes it per event, and closes it on session switch', async () => {
    const state = await bench(() => ({ ok: true, value: [] }))
    const entry = state.ctx.slots
      .entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'devflow-board')
    const seat = (entry?.inject as (() => DevflowBoardInjected) | undefined)?.()
    if (seat === undefined) throw new Error('missing board seat')

    seat.openCardDetail('0001-a' as never)
    expect(seat.hooks.devflowDetail.getSnapshot().id).toBe('0001-a')
    await flush()
    expect(state.readCalls).toEqual([['0001-a', 'ses-one']])
    await flush()
    const loaded = seat.hooks.devflowDetail.getSnapshot()
    expect(loaded.card).toMatchObject({ id: '0001-a' })
    expect(loaded.entries).toHaveLength(2)
    expect(loaded.holder).toMatchObject({ owner: { kind: 'human' } })
    // Only sessions the client list knows become backlinks.
    expect(loaded.openableSessions).toEqual(['ses-known'])

    // The session backlink intent routes to the client sessions service.
    seat.openSession('ses-known')
    expect(state.openedSessions).toEqual(['ses-known'])

    // A forwarded devflow event refetches the open detail with the board.
    state.pushFrame('devflow/stage-changed')
    await flush()
    expect(state.readCalls).toHaveLength(2)

    // Back to the list stops the event-driven detail refetch.
    seat.closeCardDetail()
    state.pushFrame('devflow/stage-changed')
    await flush()
    expect(state.readCalls).toHaveLength(2)

    // A session switch closes an open detail: the card belongs to the old workspace.
    seat.openCardDetail('0002-b' as never)
    state.setCurrentSession('ses-two')
    expect(seat.hooks.devflowDetail.getSnapshot().id).toBeUndefined()

    // A settlement arriving after the detail closed must not resurrect it.
    seat.openCardDetail('0003-c' as never)
    seat.closeCardDetail()
    await flush()
    await flush()
    expect(seat.hooks.devflowDetail.getSnapshot().id).toBeUndefined()
  })

  it('closes the detail when its fetch fails or rejects', async () => {
    let mode: 'error' | 'throw' = 'error'
    const state = await bench(() => ({ ok: true, value: [] }))
    const entry = state.ctx.slots
      .entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'devflow-board')
    const seat = (entry?.inject as (() => DevflowBoardInjected) | undefined)?.()
    if (seat === undefined) throw new Error('missing board seat')
    // A refused read (the host's `ok: false` envelope) and a dead transport are
    // two different failures; both close the detail back to the list.
    const detailAnswers = (answer: (id: string) => Promise<Response>): void => {
      vi.stubGlobal('fetch', (input: string, init: { body: string }) => {
        const { id } = JSON.parse(init.body) as { id?: string }
        return input === '/devflow/api/list'
          ? Promise.resolve(jsonResponse({ ok: true, value: [] }))
          : answer(id!)
      })
    }
    detailAnswers(() => {
      if (mode === 'throw') throw new Error('wire down')
      return Promise.resolve(jsonResponse({ ok: false, error: 'no card 0001-a' }))
    })

    seat.openCardDetail('0001-a' as never)
    await flush()
    expect(seat.hooks.devflowDetail.getSnapshot().id).toBeUndefined()

    mode = 'throw'
    seat.openCardDetail('0001-a' as never)
    await flush()
    expect(seat.hooks.devflowDetail.getSnapshot().id).toBeUndefined()

    // A rejection landing after another card opened must not close IT.
    detailAnswers(() => Promise.reject(new Error('late failure')))
    seat.openCardDetail('0001-a' as never)
    detailAnswers(id => Promise.resolve(jsonResponse({ ok: true, value: { card: { id }, entries: [] } })))
    seat.openCardDetail('0002-b' as never)
    await flush()
    await flush()
    expect(seat.hooks.devflowDetail.getSnapshot().id).toBe('0002-b')
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench(() => ({ ok: true, value: [] }))
    const translate = ctx.locale.bind(NS)
    expect(translate('board.aria')).toBe(zh['board.aria'])
    ctx.locale.setLocale('en')
    expect(translate('board.aria')).toBe(en['board.aria'])
    await fiber.dispose()
    expect(translate('board.aria')).not.toBe(en['board.aria'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-devflow node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})

describe('ui-devflow invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(DevflowInvariant)
    await fiber.await()
    expect(DevflowInvariant.name).toBe('client-ui-devflow-invariant')
    expect(DevflowInvariant.inject).toEqual(['invariants'])
    await fiber.dispose()
  })
})
