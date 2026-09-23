import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { JudgementPanel } from './panel.tsx'
import { NS, en, zh, type Key } from './locales.ts'
import type { SidebarRightTabDefinition } from './sidebar-right.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { devflowJev: Key } }
export const TAB_ID = '@zhchxiao123/dsh-devflow-jev'
export const TAB_KIND = 'devflow-judgements'
export const inject = ['slots', 'locale', 'sidebarRightTabs']
export interface Config { refreshMs?: number }
export function apply(ctx: Context, config: Config = {}): void {
  const refreshMs = config.refreshMs ?? 5000
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 100) throw new Error('devflow-jev client: refreshMs must be an integer of at least 100')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'devflow-jev: dictionaries')
  const t = ctx.locale.bind(NS)
  const definition: SidebarRightTabDefinition = { id: TAB_ID, kind: TAB_KIND, title: () => t('title'), guide: [{ order: 23, title: () => t('title'), description: () => t('description'), icon: IconBranchOutline16 }] }
  ctx.effect(() => ctx.sidebarRightTabs.register(definition), 'devflow-jev: sidebar type')
  function Page({ sessionId, useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) { const { tab, sidebar } = useTabInfo(); return createElement(JudgementPanel, { key: sessionId, sessionId, visible: tab.visible && sidebar.expanded, refreshMs, t }) }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, Page)), 'devflow-jev: sidebar body')
}
