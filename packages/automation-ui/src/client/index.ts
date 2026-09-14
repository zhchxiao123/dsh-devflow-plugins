/** Native Harness sidebar registration; the session-scoped seat displays host-scoped services. */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { PanelBoundary } from './boundary.tsx'
import { AutomationPanel } from './panel.tsx'
import { NS, en, zh, type AutomationKey } from './locales.ts'
import type { SidebarRightTabDefinition } from './sidebar-right.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { automation: AutomationKey }
}
export const TAB_ID = '@zhchxiao123/dsh-automation-ui'
export const TAB_KIND = 'automation'
export const inject = ['slots', 'locale', 'sidebarRightTabs']
export interface Config { refreshMs?: number }

/** Poll cadence is deployment-controlled and validated before any contributions are installed. */
export function apply(ctx: Context, config: Config = {}): void {
  const refreshMs = config.refreshMs ?? 5000
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 100 || refreshMs > 2_147_483_647) throw new Error('automation-ui: refreshMs must be an integer between 100 and 2147483647')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'automation: dictionaries')
  const t = ctx.locale.bind(NS)
  const definition: SidebarRightTabDefinition = { id: TAB_ID, kind: TAB_KIND, title: () => t('title'), guide: [{ order: 21, title: () => t('title'), description: () => t('description'), icon: IconBranchOutline16 }] }
  ctx.effect(() => ctx.sidebarRightTabs.register(definition), 'automation: sidebar type')
  function Page({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) {
    const { tab, sidebar } = useTabInfo()
    return createElement(PanelBoundary, { t,
      children: createElement(AutomationPanel, { visible: tab.visible && sidebar.expanded, refreshMs, t }),
    })
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, Page)), 'automation: sidebar body')
}
