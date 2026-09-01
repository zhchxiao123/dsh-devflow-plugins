/**
 * Devflow board plugin, browser half. The board has two surfaces and shows
 * exactly one: a sidebar page where a sidebar foundation is composed, and the
 * floating header control everywhere else. One place decides, from the
 * foundation's presence, and swaps the mounted surface when it arrives or
 * leaves — the two can never both appear.
 *
 * Either way the data path is the same: the board arrives through the plugin's
 * own read-face route (`@zhchxiao123/dsh-devflow-web`) scoped to a session id
 * (never a path), the host resolves that session's workspace to a devflow
 * root, and one binding per session owns the board and detail snapshots plus
 * the fetches that fill them. The floating
 * surface points its single binding at the selected session; the sidebar
 * surface holds one binding per page scope, because a page shows its own
 * session's workspace no matter which session the app has in front.
 *
 * The plugin issues no mutations: card moves belong to the model tools and the
 * `/devflow` intervention plane.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DevCard } from '@zhchxiao123/dsh-devflow/client'
import { DevflowBoardAction } from './DevflowBoardAction.tsx'
import type { DevflowBoardInjected } from './DevflowBoardAction.tsx'
import { createDevflowBoardPage, STACKED_ONLY } from './DevflowBoardTab.tsx'
import { BETTER_SIDEBAR } from './better-sidebar.ts'
import type { BetterSidebarService, SidebarScope } from './better-sidebar.ts'
import { createBoardBinding } from './binding.ts'
import type { BoardBinding } from './binding.ts'
import { inProgress } from './board.ts'
import { watchChanges } from './changes.ts'
import { en, NS, zh, type DevflowKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer and session service merges used through ctx.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Devflow board copy. */
    'devflow': DevflowKey
  }
}

/** Sidebar page id; a package prefix keeps it clear of the foundation's built-ins. */
export const BOARD_TAB_ID = 'dsh-devflow:board'

/**
 * Foundation capability this plugin gates its tab badge on. Older foundations
 * ignore an unknown descriptor field, but reporting a count they never render
 * would be a silent lie in this plugin's own diagnostics.
 */
const BADGE_FEATURE = 'badge'

/** Foundation capabilities the page's own settings row needs: persistence and republication. */
const SETTINGS_FEATURE = 'pluginSettings'
const STATE_FEATURE = 'stateSubscription'

/** Page-local setting key: list and open detail side by side instead of one at a time. */
const SPLIT_VIEW_KEY = 'splitView'

export type { DevflowBoardActionProps, DevflowBoardInjected } from './DevflowBoardAction.tsx'
export { createBoardSource, createDetailSource } from './board.ts'
export type { DevflowBoardSnapshot, DevflowBoardSource, DevflowDetailSnapshot, DevflowDetailSource } from './board.ts'

/**
 * Required services for locale registration and the header-slot contribution.
 * Board data needs no service at all: it arrives over the plugin's own route
 * and its own change stream.
 */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and mount whichever board
 * surface this composition calls for.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-devflow: dictionaries')
  const currentSession = (): string | undefined => ctx.sessions.list.getSnapshot().current
  const openSession = (id: string): void => { ctx.sessions.open(id as SessionId) }

  /**
   * The floating header control: the surface used without a sidebar
   * foundation. One binding follows the selected session, and an open detail
   * belongs to the workspace it was opened from, so a selection change closes
   * it.
   */
  const floatingSurface = (scope: ClientContext): void => {
    const binding = createBoardBinding(ctx, currentSession)
    let watched = currentSession()
    scope.effect(() => ctx.sessions.list.subscribe(() => {
      const next = currentSession()
      // Only a real selection change refetches: the list store publishes far
      // more often than the selection moves.
      if (next === watched) return
      watched = next
      binding.closeCardDetail()
      void binding.refresh()
    }), 'ui-devflow: session scope refresh')
    // Every open of the change stream refetches too, so a board that was down
    // while cards moved catches up without waiting for the next move.
    scope.effect(() => watchChanges(() => { void binding.refresh() }), 'ui-devflow: change stream')
    void binding.refresh()
    scope.slots.inject(
      'conversation.session.header.utilities',
      () => scope.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'devflow-board',
        // The right-aligned utility cluster is the design's top-right anchor;
        // the board reads before the session-log control (default order 0).
        order: -10,
        locale: NS,
        inject: (): DevflowBoardInjected => ({
          hooks: { devflowBoard: binding.board, devflowDetail: binding.detail },
          openCardDetail: binding.openCardDetail,
          closeCardDetail: binding.closeCardDetail,
          openSession,
        }),
      }, DevflowBoardAction),
    )
  }

  /**
   * The sidebar page: the surface used wherever the foundation is composed.
   * Bindings are per page scope. A change frame refetches the bindings a
   * visible page watches, plus the selected session's — the one the tab badge
   * and the `+` menu report on — so a background tab of another session costs
   * nothing while the badge in front of the user stays live.
   */
  const sidebarSurface = (sidebar: BetterSidebarService) => (scope: ClientContext): void => {
    const bindings = new Map<string, { binding: BoardBinding; watchers: number }>()
    // A page whose session the app has not selected still has a workspace: the
    // store's configured default root. One key stands for it.
    const keyOf = (sessionId: string | undefined): string => sessionId ?? ''
    const entryFor = (sessionId: string | undefined): { binding: BoardBinding; watchers: number } => {
      const existing = bindings.get(keyOf(sessionId))
      if (existing !== undefined) return existing
      const created = { binding: createBoardBinding(ctx, () => sessionId), watchers: 0 }
      bindings.set(keyOf(sessionId), created)
      return created
    }
    const watch = (sessionId: string): (() => void) => {
      const entry = entryFor(sessionId)
      entry.watchers += 1
      void entry.binding.refresh()
      return () => { entry.watchers -= 1 }
    }
    const refreshLive = (): void => {
      const selected = keyOf(currentSession())
      for (const [key, entry] of bindings) {
        if (entry.watchers > 0 || key === selected) void entry.binding.refresh()
      }
    }
    scope.effect(() => watchChanges(refreshLive), 'ui-devflow: change stream')
    // A newly selected session's badge and menu availability need its board;
    // only a real selection change fetches, as on the floating surface.
    let selected = currentSession()
    scope.effect(() => ctx.sessions.list.subscribe(() => {
      const next = currentSession()
      if (next === selected) return
      selected = next
      void entryFor(next).binding.refresh()
    }), 'ui-devflow: session scope refresh')
    void entryFor(currentSession()).binding.refresh()

    /**
     * The cards last fetched for one page scope, without allocating: the
     * foundation calls the descriptor's read-only callbacks on every tab-bar
     * render, for whichever scopes it happens to hold.
     */
    const cardsOf = (sessionId: string): readonly DevCard[] | undefined =>
      bindings.get(keyOf(sessionId))?.binding.board.getSnapshot().cards
    // The side-by-side preference is a page setting the foundation persists
    // and re-publishes; without those two capabilities the page stays stacked.
    const announced = sidebar.features?.includes(SETTINGS_FEATURE) === true
      && sidebar.features.includes(STATE_FEATURE)
    const subscribeState = sidebar.subscribeState?.bind(sidebar)
    const getSnapshot = sidebar.getSnapshot?.bind(sidebar)
    const splitView = announced && subscribeState !== undefined && getSnapshot !== undefined
      ? {
        subscribe: subscribeState,
        get: (): boolean => getSnapshot().prefs.pluginSettings[BOARD_TAB_ID]?.[SPLIT_VIEW_KEY] === true,
      }
      // Defaulting is explicit and happens here, where the capability is known;
      // the page never re-decides what "no preference source" means.
      : STACKED_ONLY
    const page = createDevflowBoardPage({
      bindingFor: sessionId => entryFor(sessionId).binding,
      watch,
      openSession,
      splitView,
      t: ctx.locale.bind(NS),
    })
    /**
     * In-progress count of one page scope, from the last fetch — never a
     * request. Counted exactly as the page's own stats head counts it, so the
     * badge and the line under it can never disagree.
     */
    const activeCount = (_ctx: unknown, pageScope: SidebarScope): number | undefined => {
      const active = cardsOf(pageScope.sessionId)?.filter(inProgress).length
      return active === undefined || active === 0 ? undefined : active
    }
    const badge = sidebar.features?.includes(BADGE_FEATURE) === true ? { badge: activeCount } : {}
    scope.effect(() => {
      try {
        return sidebar.registerTab({
          id: BOARD_TAB_ID,
          // A function title re-reads on every render, so the page follows a
          // locale switch without re-registering.
          title: () => ctx.locale.bind(NS)('panel.title'),
          // After the foundation's own pages (explorer 10 … browser 50).
          order: 60,
          single: true,
          // A workspace known to hold no cards offers the page as unavailable
          // rather than hiding it; a workspace nothing has fetched yet stays
          // openable, since opening it is what fetches.
          available: (_ctx, pageScope) => cardsOf(pageScope.sessionId)?.length !== 0,
          ...badge,
          ...splitView === STACKED_ONLY
            ? {}
            : {
              settings: {
                pluginToggles: [{
                  key: SPLIT_VIEW_KEY,
                  title: () => ctx.locale.bind(NS)('settings.splitView'),
                  desc: () => ctx.locale.bind(NS)('settings.splitView.desc'),
                }],
              },
            },
          component: page,
        })
      } catch (error) {
        // The foundation rejects a duplicate page id. That is a composition
        // problem for the deployment to fix, not a reason to take the rest of
        // this plugin (dictionaries, fetches, the session backlink) down.
        ctx.logger.warn(`ui-devflow: the sidebar foundation refused the board page: ${String(error)}`)
        return () => {}
      }
    }, 'ui-devflow: sidebar page')
  }

  // ONE place decides which surface exists, so the two can never both appear:
  // the foundation's presence picks it, and its arrival or departure swaps the
  // mounted child fiber. Disposing this plugin disposes whichever is up.
  let mounted: 'floating' | 'sidebar' | undefined
  let surface: ReturnType<typeof ctx.plugin> | undefined
  const chooseSurface = (): void => {
    // The foundation is optional and lives outside this workspace, so it is
    // read by service name; `get` is untyped for names this program does not
    // declare.
    const sidebar = ctx.get(BETTER_SIDEBAR) as BetterSidebarService | undefined
    const next = sidebar === undefined ? 'floating' : 'sidebar'
    if (next === mounted) return
    mounted = next
    void surface?.dispose()
    surface = ctx.plugin(sidebar === undefined ? floatingSurface : sidebarSurface(sidebar))
  }
  ctx.effect(() => ctx.on('internal/service', (name: string) => {
    if (name === BETTER_SIDEBAR) chooseSurface()
  }), 'ui-devflow: surface choice')
  chooseSurface()
}
