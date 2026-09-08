/**
 * The slice of the Harness right-Sidebar contract this plugin consumes.
 *
 * The implementation is composed by the current Harness Web bundle, but its
 * `@deepseek-ai/dsh-client-ui-sidebar-right` package is not published on npm
 * yet. Importing it would make this independently published plugin impossible
 * to install, so the stable service and slot boundary is restated here. A
 * divergence from the Harness package's client contract is a defect in this
 * copy.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComponentType } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'

/** One entry box contributed to the Sidebar's start page. */
export interface SidebarRightGuideEntry {
  readonly order: number
  readonly title: () => string
  readonly description: () => string
  readonly icon?: ComponentType<IconProps>
}

/** Static identity and copy for one page type. */
export interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: (address: string) => string
  readonly guide?: readonly SidebarRightGuideEntry[]
}

/** Registration face provided by the official right-Sidebar plugin. */
export interface SidebarRightTabRegistry {
  register(definition: SidebarRightTabDefinition): () => void
}

/** Live presentation facts the Devflow page reads from its tab occurrence. */
export interface SidebarRightTabInfo {
  readonly sidebar: {
    readonly expanded: boolean
    readonly fullscreen: boolean
  }
  readonly tab: {
    readonly visible: boolean
  }
}

/** Hook the official slot host supplies to every tab body. */
export type UseSidebarRightTabInfo = () => SidebarRightTabInfo

/** Slot-level hook factory declaration owned by the official right Sidebar. */
interface SidebarRightTabInjected {
  hooks: {
    tabInfo: SlotHookFactory<'sidebar.right.pane.tab', UseSidebarRightTabInfo>
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Session whose right-Sidebar surface contains this tab. */
    sessionId: SessionId
  }

  interface SlotMap {
    /** Key-dispatched tab bodies in the official right Sidebar. */
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      hookContext: unknown
      inject: SidebarRightTabInjected
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Official right-Sidebar tab-type registry. */
    sidebarRightTabs: SidebarRightTabRegistry
  }
}

/** Type-level assertion that the restated service is carried by a Cordis context. */
export type SidebarRightContext = Pick<Context, 'sidebarRightTabs'>
