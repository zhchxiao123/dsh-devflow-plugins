// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { apply, inject, TAB_ID, TAB_KIND, GITHUB_TAB_ID, GITHUB_TAB_KIND } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import type { SidebarRightTabDefinition, SidebarRightTabInfo } from '../src/client/sidebar-right.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { overview, t } from './fixtures.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('contributes an independent official Sidebar page, dictionary and keyed body for the fiber lifetime', async () => {
  const ctx = new Context()
  const definitions: SidebarRightTabDefinition[] = []
  const removed = vi.fn(); const localeRemoved = vi.fn(); const registerLocale = vi.fn(() => localeRemoved)
  ctx.provide('sidebarRightTabs', { register: (definition: SidebarRightTabDefinition) => { definitions.push(definition); return removed } })
  ctx.provide('locale', { register: registerLocale, bind: () => t } as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: (() => () => undefined) as never } } } } }, ({ renderSlot }: { renderSlot: unknown }) => { void renderSlot; return null })
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ ok: true, data: overview() })))
  vi.stubGlobal('fetch', fetch)
  const fiber = ctx.plugin({ inject, apply }); await fiber.await()
  expect(registerLocale).toHaveBeenCalledWith(NS, { en, zh })
  const definition = definitions.at(0)!
  expect(definition.id).toBe(TAB_ID); expect(definition.kind).toBe(TAB_KIND)
  expect(definition.title('')).toBe('自动化'); expect(definition.guide?.[0]?.title()).toBe('自动化'); expect(definition.guide?.[0]?.description?.()).toBe(zh.description)
  expect(definitions.at(1)!.id).toBe(GITHUB_TAB_ID); expect(definitions.at(1)!.kind).toBe(GITHUB_TAB_KIND); expect(definitions.at(1)!.title('')).toBe(zh.subscriptions); expect(definitions.at(1)!.guide?.[0]?.title()).toBe(zh.subscriptions); expect(definitions.at(1)!.guide?.[0]?.description?.()).toBe(zh.githubDescription)
  expect(Object.keys(en)).toEqual(Object.keys(zh))
  const entry = ctx.slots.entries('sidebar.right.pane.tab').find(item => item.options.key === TAB_ID)!
  const Page = entry.component as ComponentType<{ sessionId: string; useTabInfo: () => SidebarRightTabInfo }>
  const openTab = vi.fn()
  const info = (visible: boolean, expanded: boolean): SidebarRightTabInfo => ({
    tab: { visible, navigation: { revision: 0, params: undefined }, actions: { openResource: () => {}, openTab } },
    sidebar: { expanded, fullscreen: false } })
  const view = render(<Page sessionId="one" useTabInfo={() => info(false, true)} />)
  expect(fetch).not.toHaveBeenCalled()
  view.rerender(<Page sessionId="two" useTabInfo={() => info(true, false)} />); expect(fetch).not.toHaveBeenCalled()
  view.rerender(<Page sessionId="two" useTabInfo={() => info(true, true)} />)
  await screen.findByRole('article', { name: 'Schedule plan' })
  expect(fetch.mock.calls).toHaveLength(1)
  expect(JSON.parse(fetch.mock.calls.at(0)![1].body as string)).toEqual({ method: 'overview', sessionId: 'two' })
  fireEvent.click(screen.getByRole('button', { name: zh.subscriptions }))
  expect(openTab).toHaveBeenCalledWith('github-subscriptions', { params: { subscriptionId: 'sub' } })
  const GithubPage = ctx.slots.entries('sidebar.right.pane.tab').find(item => item.options.key === GITHUB_TAB_ID)!.component as typeof Page
  view.rerender(<GithubPage sessionId="three" useTabInfo={() => info(true, true)} />)
  await screen.findByRole('article', { name: 'owner/sub' })
  fireEvent.click(screen.getByRole('button', { name: zh.scheduleSync }))
  expect(openTab).toHaveBeenLastCalledWith('automation', { params: { subscriptionId: 'sub' } })
  view.unmount(); await act(async () => { await fiber.dispose() })
  expect(removed).toHaveBeenCalledTimes(2); expect(localeRemoved).toHaveBeenCalledOnce()
  expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
  nodeApply()
})
it('rejects unusable polling configuration before registering any contribution', () => {
  for (const refreshMs of [0, 99, 1.5, NaN, Infinity, 2147483648]) expect(() =>{  apply(new Context(), { refreshMs }) }).toThrow('refreshMs')
})

it('contains a page render failure and lets the reader retry without losing the shell', async () => {
  const { PanelBoundary } = await import('../src/client/boundary.tsx')
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  let broken = true
  function Child() { if (broken) throw new Error('render failure'); return <p>Recovered</p> }
  render(<PanelBoundary t={t}><Child /></PanelBoundary>)
  expect(screen.getByRole('alert').textContent).toContain(zh.renderError)
  broken = false
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  expect(screen.getByText('Recovered')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull()
  consoleError.mockRestore()
})
