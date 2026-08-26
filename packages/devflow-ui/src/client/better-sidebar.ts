/**
 * The slice of the `dsh-better-sidebar` foundation this plugin talks to,
 * restated locally.
 *
 * The foundation is an optional ecosystem plugin outside this workspace. It is
 * deliberately neither imported nor declared as a dependency: the client bundle
 * purity gate forbids cross-plugin value imports, and a type-only import would
 * still add a declaration edge to a package this repository does not resolve.
 * Everything crosses through the service name below, the integration path the
 * foundation's own guide records for third-party pages.
 *
 * Only the fields this plugin fills in or reads are restated; the foundation's
 * descriptor carries many more. A field this file does not name is simply not
 * used here.
 */
import type { ReactNode } from 'react'

/** Service name the foundation provides on the client context. */
export const BETTER_SIDEBAR = 'betterSidebar'

/** The session a sidebar page renders for. */
export interface SidebarScope {
  /** Session whose workspace the page shows; every data call is scoped to it. */
  sessionId: string
}

/** Props the foundation hands a registered page on every render. */
export interface SidebarTabProps {
  /** The page's own session scope, independent of which session the app shows. */
  scope: SidebarScope
  /** Whether this page is the active tab of an expanded panel. */
  visible: boolean
}

/**
 * The tab descriptor fields this plugin supplies. The foundation passes its
 * own context and panel state as the first and third arguments of the callback
 * fields; this plugin reads neither, so they stay `unknown` rather than
 * dragging the foundation's whole state vocabulary in here.
 */
export interface SidebarTabDescriptor {
  /** Unique page id; a package prefix keeps it clear of the foundation's built-ins. */
  id: string
  /** Page title; a function is re-read on every render, so it follows the active locale. */
  title: string | (() => string)
  /** Sort order in the foundation's `+` menu; larger sorts later. */
  order?: number
  /** Single-instance page: opening again focuses the existing one. */
  single?: boolean
  /** Whether the page can be opened from the `+` menu; false renders it disabled, not hidden. */
  available?: (ctx: unknown, scope: SidebarScope, state: unknown) => boolean
  /**
   * Declarative settings shown on this page's card in the host settings page.
   * `pluginToggles` rows are page-local: the foundation persists them under
   * `prefs.pluginSettings[<page id>]`, no host schema field needed.
   */
  settings?: {
    pluginToggles?: readonly {
      key: string
      title: string | (() => string)
      desc?: string | (() => string)
    }[]
  }
  /**
   * Small pill beside the tab icon. Called on every tab-bar render, so it must
   * stay cheap; `undefined` renders no pill.
   */
  badge?: (ctx: unknown, scope: SidebarScope, state: unknown) => string | number | null | undefined
  /** The page body. */
  component: (props: SidebarTabProps) => ReactNode
}

/** The foundation state this plugin reads: only the page-local settings blobs. */
export interface SidebarSnapshot {
  prefs: {
    /** Page-local persisted settings, keyed by page id. */
    pluginSettings: Record<string, Record<string, unknown>>
  }
}

/** The `ctx.betterSidebar` surface this plugin reads and calls. */
export interface BetterSidebarService {
  /**
   * Register one sidebar page.
   * @param descriptor - the page to add.
   * @returns the disposer that unregisters it.
   */
  registerTab(descriptor: SidebarTabDescriptor): () => void
  /**
   * Monotonic capability list of the composed foundation; absent on the
   * versions that predate it. Gate on membership, never on a version string.
   */
  readonly features?: readonly string[]
  /**
   * Current foundation state, including the persisted page settings.
   * @returns the snapshot.
   */
  getSnapshot?(): SidebarSnapshot
  /**
   * Subscribe to foundation state changes, settings writes included.
   * @param listener - called after every change.
   * @returns the disposer.
   */
  subscribeState?(listener: () => void): () => void
}
