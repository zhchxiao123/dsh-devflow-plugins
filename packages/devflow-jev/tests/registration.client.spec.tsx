// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { cleanup, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { apply, inject, TAB_ID, TAB_KIND } from '../src/client/index.ts'
import type { SidebarRightTabDefinition, SidebarRightTabInfo } from '../src/client/sidebar-right.ts'
import { en, NS, zh, type Key } from '../src/client/locales.ts'
const t = (key: Key): string => zh[key]
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('mounts the native sidebar contribution and removes every registration on disposal', async () => {
  const ctx = new Context()
  const definitions: SidebarRightTabDefinition[] = []
  const removed = vi.fn(); const localeRemoved = vi.fn(); const registerLocale = vi.fn(() => localeRemoved)
  ctx.provide('sidebarRightTabs', { register: (definition: SidebarRightTabDefinition) => { definitions.push(definition); return removed } })
  ctx.provide('locale', { register: registerLocale, bind: () => t } as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: (() => () => undefined) as never } } } } }, ({ renderSlot }: { renderSlot: unknown }) => { void renderSlot; return null })
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string) as { method: string }
    return new Response(JSON.stringify({ ok: true, data: input.method === 'context' ? { projectName: 'Registered project', projectPath: '/project', genericRunsAvailable: false } : [] }))
  })
  vi.stubGlobal('fetch', fetch)
  const fiber = ctx.plugin({ inject, apply }); await fiber.await()
  expect(registerLocale).toHaveBeenCalledWith(NS, { en, zh })
  const definition = definitions.at(0)!
  expect(definition.id).toBe(TAB_ID); expect(definition.kind).toBe(TAB_KIND)
  expect(definition.title('')).toBe(zh.title)
  expect(definition.guide?.[0]?.title()).toBe(zh.title)
  expect(definition.guide?.[0]?.description?.()).toBe(zh.description)
  const entry = ctx.slots.entries('sidebar.right.pane.tab').find(item => item.options.key === TAB_ID)!
  const Page = entry.component as ComponentType<{ sessionId: string; useTabInfo: () => SidebarRightTabInfo }>
  const info = (visible: boolean, expanded: boolean): SidebarRightTabInfo => ({
    tab: { visible, navigation: { revision: 0, params: undefined }, actions: { openResource: () => {}, openTab: () => {} } },
    sidebar: { expanded, fullscreen: false },
  })
  const view = render(<Page sessionId="one" useTabInfo={() => info(false, true)} />)
  expect(fetch).not.toHaveBeenCalled()
  view.rerender(<Page sessionId="two" useTabInfo={() => info(true, false)} />)
  expect(fetch).not.toHaveBeenCalled()
  view.rerender(<Page sessionId="two" useTabInfo={() => info(true, true)} />)
  await screen.findByText('Registered project')
  view.unmount(); await act(async () => { await fiber.dispose() })
  expect(removed).toHaveBeenCalledOnce(); expect(localeRemoved).toHaveBeenCalledOnce()
  expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
})
it('validates polling configuration before registering contributions', () => {
  for (const refreshMs of [0, 99, 1.5, NaN, Infinity]) expect(() => { apply(new Context(), { refreshMs }) }).toThrow('refreshMs')
})
