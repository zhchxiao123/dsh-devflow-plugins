// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRequest } from '@zhchxiao123/dsh-automation-web/client'
import { AutomationPanel as NativePanel, sourceURL } from '../src/client/panel.tsx'
import { useState } from 'react'
import { overview, plan, run, subscription, t } from './fixtures.ts'

function AutomationPanel(props: { visible: boolean; refreshMs: number; t: typeof t }) {
  const [page, setPage] = useState<'automation' | 'github-subscriptions'>('github-subscriptions')
  const [navigation, setNavigation] = useState<unknown>()
  const [revision, setRevision] = useState(0)
  const openTab = (kind: string, options?: { params?: unknown }): void => { setPage(kind === 'automation' ? 'automation' : 'github-subscriptions'); setNavigation(options?.params); setRevision(value => value + 1) }
  return <><button onClick={() => { openTab(page === 'automation' ? 'github-subscriptions' : 'automation') }}>{t(page === 'automation' ? 'subscriptions' : 'plans')}</button><NativePanel {...props} page={page} sessionId="one" navigation={navigation} navigationRevision={revision} openTab={openTab} /></>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
const reply = (data: unknown): Response => new Response(JSON.stringify({ ok: true, data }), { status: 200 })
function bench() {
  const state = { value: overview(), requests: [] as AutomationRequest[], fail: '', content: [] as unknown[] }
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    if (typeof options.body !== 'string') throw new Error('expected JSON request')
    const request = JSON.parse(options.body) as AutomationRequest
    state.requests.push(request)
    if (state.fail !== '') throw new Error(state.fail)
    switch (request.method) {
      case 'overview': return reply(state.value)
      case 'unassigned': return reply({ plans: [], subscriptions: [] })
      case 'claim': return reply(subscription())
      case 'content': return reply(state.content)
      case 'subscription.save': return reply({ ...subscription(), ...request.input })
      case 'subscription.action': return reply(subscription())
      case 'plan.save': return reply({ ...plan(), ...request.input })
      case 'plan.action': return reply(null)
      case 'run.action': return reply(null)
      case 'capacity.set': return reply({ bytes: 0, capacityBytes: request.bytes, blocked: false })
    }
  }))
  return state
}
async function ready(): Promise<void> { await screen.findByRole('article', { name: 'owner/sub' }) }
async function click(label: string, parent: HTMLElement = document.body): Promise<void> {
  fireEvent.click(within(parent).getAllByRole('button', { name: label }).at(0)!)
  await act(async () => {})
}

describe('Automation native page behavior', () => {
  it('shows initial loading, empty collections and unavailable services independently', async () => {
    const state = bench(); state.value = { ...state.value, subscriptions: [], plans: [], runs: [], storage: null }
    render(<AutomationPanel visible={true} refreshMs={5000} t={t} />)
    expect(screen.getByText(t('loading'))).toBeTruthy(); await screen.findByText(t('empty'))
    await click(t('plans')); await screen.findByRole('button', { name: t('add') }); expect(screen.getByRole('button', { name: t('add') })).toHaveProperty('disabled', true)
    await click(t('deliveries')); expect(screen.getByText(t('empty'))).toBeTruthy()
    state.value.githubAvailable = false; state.value.schedulerAvailable = false
    await click(t('refresh')); expect(screen.getByText(t('unavailable'))).toBeTruthy()
    await click(t('plans')); expect(screen.getByText(t('unavailable'))).toBeTruthy()
    await click(t('subscriptions')); await screen.findByText(t('unavailable')); expect(screen.getByText(t('unavailable'))).toBeTruthy()
  })
  it('keeps subscriptions visible on refresh errors and retries both initial and later reads', async () => {
    const state = bench(); state.fail = 'offline'
    render(<AutomationPanel visible={true} refreshMs={5000} t={t} />)
    await screen.findByRole('alert'); expect(screen.queryByText(t('stale'))).toBeNull()
    state.fail = ''; await click(t('refresh'), screen.getByRole('banner')); await ready()
    state.fail = 'later-offline'; await click(t('refresh'), screen.getByRole('banner'))
    expect(screen.getByText(t('stale'))).toBeTruthy(); expect(screen.getByRole('article', { name: 'owner/sub' })).toBeTruthy()
    state.fail = ''; await click(t('refresh'), screen.getByRole('alert')); expect(screen.queryByRole('alert')).toBeNull()
  })
  it('creates and edits subscriptions, syncs, pauses and resumes through service requests', async () => {
    const state = bench(); render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready()
    await click(t('add')); fireEvent.change(screen.getByLabelText(t('repository')), { target: { value: 'owner/new' } })
    await click(t('save'), screen.getByRole('form', { name: t('subscriptions') })); expect(state.requests).toContainEqual({ sessionId: 'one', method: 'subscription.save', input: { repository: 'owner/new', issues: true, discussions: false } })
    expect(screen.queryByRole('form')).toBeNull(); expect(screen.getByRole('status').textContent).toBe(t('saved'))
    const card = screen.getByRole('article', { name: 'owner/sub' })
    await click(t('edit'), card); await click(t('close')); expect(screen.queryByRole('form')).toBeNull()
    await click(t('sync'), card); await click(t('pause'), card)
    state.value.subscriptions[0] = { ...subscription(), paused: true, discussions: true }
    await click(t('refresh')); await click(t('resume'), card)
    expect(state.requests).toContainEqual({ sessionId: 'one', method: 'subscription.action', id: 'sub', action: 'resume' })
    state.fail = 'subscription-paused'; await click(t('sync'), card); expect(screen.getByRole('alert').textContent).toContain('subscription-paused')
  })
  it('shows untrusted bodies as text, only links HTTP sources, and adjusts capacity', async () => {
    const state = bench(); state.value.storage = { bytes: 10, capacityBytes: 20, blocked: true, error: 'capacity-full' }
    const snapshot = { id: 'one', subscriptionId: 'sub', kind: 'issue', url: 'https://github.com/owner/sub/issues/1', updatedAt: 'now', title: 'Issue title', body: '<img src=x onerror=alert(1)>', state: 'open', version: 2, fingerprint: 'f', fetchedAt: 1000, deleted: false }
    state.content = [snapshot, { ...snapshot, id: 'two', url: 'javascript:alert(1)' }]
    const view = render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready()
    expect(screen.getByText(t('blocked'))).toBeTruthy()
    fireEvent.change(screen.getByLabelText(t('capacity')), { target: { value: '9000' } }); fireEvent.submit(screen.getByLabelText(t('capacity')).closest('form')!)
    await act(async () => {}); expect(state.requests).toContainEqual({ sessionId: 'one', method: 'capacity.set', bytes: 9000 })
    await click(t('content'))
    await waitFor(() =>{  expect(screen.getAllByText('Issue title')).toHaveLength(2) })
    expect(view.container.querySelector('img')).toBeNull(); expect(screen.getAllByText(snapshot.body)).toHaveLength(2)
    expect(screen.getByRole('link')).toHaveProperty('href', snapshot.url); expect(screen.getByText('javascript:alert(1)')).toBeTruthy()
    await click(t('back')); state.content = []; await click(t('content')); await screen.findByText(t('empty')); await click(t('back'))
    state.fail = 'content-offline'; await click(t('content')); await screen.findByRole('alert')
    state.fail = ''; state.content = [snapshot]; await click(t('refresh'), screen.getByRole('alert')); await screen.findByText('Issue title')
    state.content = [{ ...snapshot, title: 'Updated title' }]; await click(t('refresh')); await screen.findByText('Updated title')
  })
  it('creates schedules and manages interval, Cron and generic plans without losing params', async () => {
    const state = bench()
    state.value.plans.push({ ...plan('cron'), enabled: false, rule: { kind: 'cron', expression: '0 * * * *', timezone: 'UTC' } })
    render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready(); await click(t('plans'))
    await click(t('add')); fireEvent.change(screen.getByLabelText(t('name')), { target: { value: 'New schedule' } }); await click(t('save'))
    expect(state.requests.some(request => request.method === 'plan.save')).toBe(true)
    const card = screen.getByRole('article', { name: 'Schedule plan' }); const cron = screen.getByRole('article', { name: 'Schedule cron' })
    await click(t('edit'), card); await click(t('close'))
    await click(t('trigger'), card); await click(t('pause'), card); await click(t('resume'), cron)
    await click(t('remove'), card); await click(t('close'), card); await click(t('remove'), card); await click(t('confirmRemove'), card)
    expect(state.requests).toContainEqual({ sessionId: 'one', method: 'plan.action', id: 'plan', action: 'remove' })
    expect(screen.queryByText(t('removeHint'))).toBeNull()
  })
  it('shows run progression, waits and errors, resumes partial/failed runs and cancels pending delivery', async () => {
    const state = bench()
    state.value.runs = [run(), { ...run('partial'), status: 'partial', completedAt: 5000, error: 'page-budget', waitUntil: 6000 }, { ...run('failed'), status: 'failed' }, { ...run('done'), status: 'succeeded' }]
    state.value.triggers = [{ projectId: 'project-one', id: 'trigger', planId: 'plan', scheduledAt: 1000, state: 'accepted', attempts: 1, requestedBy: 'test', runId: 'run', error: 'temporary' }, { projectId: 'project-one', id: 'orphan', planId: 'deleted-plan', scheduledAt: 2000, state: 'completed', attempts: 1, requestedBy: 'test' }]
    render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready(); await click(t('runs'))
    const cards = screen.getAllByRole('article')
    expect(screen.getByText('page-budget')).toBeTruthy(); expect(screen.getByText(t('wait'))).toBeTruthy()
    await click(t('cancel'), cards[0]); await click(t('resume'), cards[1]); await click(t('resume'), cards[2]); await click(t('plans')); await click(t('deliveries')); const deliveries = screen.getAllByRole('article'); await click(t('cancel'), deliveries[0])
    expect(state.requests).toContainEqual({ sessionId: 'one', method: 'plan.action', id: 'trigger', action: 'cancel' })
    await click(t('plans'), deliveries[0]); expect(screen.getByRole('article', { name: 'Schedule plan' })).toBeTruthy()
    await click(t('subscriptions')); await click(t('runs')); await click(t('content'), screen.getAllByRole('article')[0]); await screen.findByText(t('empty'))
  })
  it('accepts safe source URLs and leaves invalid or dangerous schemes inert', () => {
    expect(sourceURL('http://example.com/a')).toBe('http://example.com/a')
    expect(sourceURL('not a url')).toBeUndefined(); expect(sourceURL('data:text/html,bad')).toBeUndefined()
  })
})

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('refreshes only a visible page and stops timers when the sidebar hides', async () => {
  vi.useFakeTimers()
  const state = bench()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const view = render(<AutomationPanel visible={true} refreshMs={100} t={t} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(200) }); expect(state.requests).toHaveLength(0)
  visibility.mockReturnValue('visible'); fireEvent(document, new Event('visibilitychange'))
  await act(async () => {}); expect(state.requests).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(100) }); expect(state.requests).toHaveLength(2)
  view.rerender(<AutomationPanel visible={false} refreshMs={100} t={t} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(300) }); expect(state.requests).toHaveLength(2)
  view.unmount(); expect(vi.getTimerCount()).toBe(0); visibility.mockRestore()
})

it.each(['resolve', 'reject'] as const)('ignores an obsolete overview %s after the pane is hidden', async (outcome) => {
  const request = pending<Response>(); const fetch = vi.fn(() => request.promise); vi.stubGlobal('fetch', fetch)
  const view = render(<AutomationPanel visible={true} refreshMs={5000} t={t} />)
  view.rerender(<AutomationPanel visible={false} refreshMs={5000} t={t} />)
  await act(async () => { if (outcome === 'resolve') request.resolve(reply(overview())); else request.reject(new Error('late-error')) })
  expect(screen.queryByRole('article')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['resolve', 'reject'] as const)('ignores obsolete content %s after navigating away', async (outcome) => {
  const request = pending<Response>()
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest
    return body.method === 'content' ? request.promise : reply(overview())
  })
  render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready(); await click(t('content')); await click(t('back'))
  await act(async () => { if (outcome === 'resolve') request.resolve(reply([])); else request.reject(new Error('late-content-error')) })
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('article', { name: 'owner/sub' })).toBeTruthy()
})

it.each(['resolve', 'reject'] as const)('lets an accepted mutation %s after unmount without starting a new read', async (outcome) => {
  const request = pending<Response>()
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest
    return body.method === 'overview' ? reply(overview()) : request.promise
  }); vi.stubGlobal('fetch', fetch)
  const view = render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready(); await click(t('sync'))
  expect(fetch).toHaveBeenCalledTimes(2); view.unmount()
  await act(async () => { if (outcome === 'resolve') request.resolve(reply(subscription())); else request.reject(new Error('late-write-error')) })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('coalesces repeated form submissions until the first write settles', async () => {
  const request = pending<Response>()
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest
    return body.method === 'overview' ? reply(overview()) : request.promise
  }); vi.stubGlobal('fetch', fetch)
  render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready(); await click(t('add'))
  const form = screen.getByRole('form', { name: t('subscriptions') })
  fireEvent.submit(form); fireEvent.submit(form); expect(fetch).toHaveBeenCalledTimes(2)
  await act(async () => { request.resolve(reply(subscription())) }); expect(fetch).toHaveBeenCalledTimes(3)
})

it('links subscriptions to their plans and reports the last successful sync', async () => {
  const state = bench()
  state.value.subscriptions[0] = { ...subscription(), lastSuccessAt: 1000 }
  state.value.plans.push({ ...plan('null'), params: null }, { ...plan('primitive'), params: 'opaque' }, { ...plan('no-link'), params: {} })
  render(<AutomationPanel visible={true} refreshMs={5000} t={t} />); await ready()
  expect(screen.getByText(new RegExp(t('lastSuccess')))).toBeTruthy()
  await click('Schedule plan'); expect(screen.getByRole('article', { name: 'Schedule plan' })).toBeTruthy()
})

it('lets slow overview and content reads finish across multiple polling ticks', async () => {
  vi.useFakeTimers()
  const overviewRead = pending<Response>(); const contentRead = pending<Response>()
  let overviewCalls = 0; let contentCalls = 0
  const signals: (AbortSignal | null | undefined)[] = []
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest
    if (body.method === 'content') { contentCalls += 1; signals.push(options.signal); return contentRead.promise }
    overviewCalls += 1
    return overviewCalls === 1 ? overviewRead.promise : reply(overview())
  })
  const view = render(<AutomationPanel visible={true} refreshMs={100} t={t} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(overviewCalls).toBe(1)
  await act(async () => { overviewRead.resolve(reply(overview())) })
  expect(screen.getByRole('article', { name: 'owner/sub' })).toBeTruthy()
  await click(t('content'))
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(overviewCalls).toBe(5); expect(contentCalls).toBe(1); expect(signals[0]?.aborted).toBe(false)
  await act(async () => { contentRead.resolve(reply([])) })
  expect(screen.getByText(t('empty'))).toBeTruthy()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(contentCalls).toBe(1); expect(overviewCalls).toBe(5)
  visibility.mockRestore(); view.unmount()
})

it('retains failed writes through successful polls until dismissed or another action succeeds', async () => {
  vi.useFakeTimers()
  let failWrite = true
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest
    if (body.method === 'overview') return reply(overview())
    if (failWrite) throw new Error('write-refused')
    return reply(subscription())
  })
  render(<AutomationPanel visible={true} refreshMs={100} t={t} />); await act(async () => {})
  await click(t('sync')); expect(screen.getByRole('alert').textContent).toContain('write-refused')
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(screen.getByRole('alert').textContent).toContain('write-refused'); expect(screen.queryByText(t('stale'))).toBeNull()
  await click(t('close'), screen.getByRole('alert')); expect(screen.queryByRole('alert')).toBeNull()
  await click(t('sync')); expect(screen.getByRole('alert')).toBeTruthy()
  failWrite = false; await click(t('sync')); expect(screen.queryByRole('alert')).toBeNull()
})

it('retains content errors while an independent overview poll succeeds and the content retry is pending', async () => {
  vi.useFakeTimers()
  const retry = pending<Response>(); let contentCalls = 0
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as AutomationRequest
    if (body.method === 'overview') return reply(overview())
    contentCalls += 1
    if (contentCalls === 1) throw new Error('content-refused')
    return retry.promise
  })
  render(<AutomationPanel visible={true} refreshMs={100} t={t} />); await act(async () => {})
  await click(t('content')); expect(screen.getByRole('alert').textContent).toContain('content-refused')
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(contentCalls).toBe(2); expect(screen.getByRole('alert').textContent).toContain('content-refused')
  await act(async () => { retry.resolve(reply([])) })
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText(t('empty'))).toBeTruthy()
})

it('separates native pages, carries navigation and defaults a scheduled sync to its selected subscription', async () => {
  const state = bench(); state.value.subscriptions.push(subscription('second'))
  const openTab = vi.fn()
  const props = { sessionId: 'one', visible: true, refreshMs: 5000, t, openTab }
  const view = render(<NativePanel {...props} page="github-subscriptions" />); await ready()
  expect(screen.queryByRole('button', { name: t('plans') })).toBeNull()
  await click(t('scheduleSync'), screen.getByRole('article', { name: 'owner/second' }))
  expect(openTab).toHaveBeenLastCalledWith('automation', { params: { subscriptionId: 'second' } })
  view.rerender(<NativePanel {...props} page="automation" navigation={{ subscriptionId: 'second' }} navigationRevision={1} />)
  await screen.findByRole('form', { name: t('plans') })
  expect(screen.getByLabelText(t('subscription'))).toHaveProperty('value', 'second')
  expect(screen.queryByRole('article', { name: 'owner/sub' })).toBeNull()
  await click(t('close'))
  await click(t('subscriptions'), screen.getByRole('article', { name: 'Schedule plan' }))
  expect(openTab).toHaveBeenLastCalledWith('github-subscriptions', { params: { subscriptionId: 'sub' } })
  state.value.triggers = [{ projectId: 'project-one', id: 'delivery', planId: 'plan', state: 'completed', scheduledAt: 1000, attempts: 1, requestedBy: 'test', runId: 'run' }]
  await click(t('refresh'), screen.getByRole('banner')); await click(t('deliveries')); await click('run')
  expect(openTab).toHaveBeenLastCalledWith('github-subscriptions', { params: { runId: 'run' } })
  view.rerender(<NativePanel {...props} page="github-subscriptions" navigation={{ runId: 'run' }} navigationRevision={2} />)
  await screen.findByText(t('detail'))
  expect(screen.getAllByRole('article')).toHaveLength(1)
  expect(screen.getByRole('article').getAttribute('data-selected')).toBe('true')
  view.rerender(<NativePanel {...props} page="github-subscriptions" navigation={{ subscriptionId: 'sub' }} navigationRevision={3} />)
  await screen.findByText(t('empty')); expect(state.requests).toContainEqual({ method: 'content', sessionId: 'one', subscriptionId: 'sub' })
  view.rerender(<NativePanel {...props} page="automation" navigation={{ planId: 'plan', subscriptionId: 42 }} navigationRevision={4} />)
  await screen.findByRole('article', { name: 'Schedule plan' }); expect(screen.queryByRole('form')).toBeNull()
  expect(screen.getByRole('article').getAttribute('data-selected')).toBe('true')
})

it('does not request a global view without a session and resets project forms on session changes', async () => {
  const state = bench(); const openTab = vi.fn()
  const props = { page: 'github-subscriptions' as const, visible: true, refreshMs: 5000, t, openTab }
  const view = render(<NativePanel {...props} sessionId="" />)
  expect(screen.getByText(t('noProject'))).toBeTruthy(); expect(state.requests).toHaveLength(0)
  view.rerender(<NativePanel {...props} sessionId="one" />); await ready(); await click(t('add'))
  fireEvent.change(screen.getByLabelText(t('repository')), { target: { value: 'old/private' } })
  state.value = { ...overview(), project: { id: 'two', title: 'Project Two' }, subscriptions: [], plans: [], runs: [] }
  view.rerender(<NativePanel {...props} sessionId="two" />)
  expect(screen.queryByRole('form')).toBeNull(); expect(screen.queryByText('owner/sub')).toBeNull()
  await screen.findByText('当前项目: Project Two')
  expect(state.requests.at(-1)).toEqual({ method: 'overview', sessionId: 'two' })
})

it.each(['resolve', 'reject'] as const)('ignores a late previous-session mutation %s', async (outcome) => {
  const write = pending<Response>(); const requests: AutomationRequest[] = []
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string) as AutomationRequest; requests.push(request)
    if (request.method !== 'overview') return write.promise
    return reply(request.sessionId === 'one' ? overview() : { ...overview(), project: { id: 'two', title: 'Second' }, subscriptions: [], plans: [], runs: [] })
  })
  const props = { page: 'github-subscriptions' as const, visible: true, refreshMs: 5000, t, openTab: vi.fn() }
  const view = render(<NativePanel {...props} sessionId="one" />); await ready(); await click(t('sync'))
  view.rerender(<NativePanel {...props} sessionId="two" />); await screen.findByText('当前项目: Second')
  await act(async () => { if (outcome === 'resolve') write.resolve(reply(subscription())); else write.reject(new Error('old-error')) })
  expect(screen.queryByText(t('saved'))).toBeNull(); expect(screen.queryByRole('alert')).toBeNull(); expect(requests).toHaveLength(3)
})

it.each(['resolve', 'reject'] as const)('drops content and ignores a write %s when a session changes its project binding', async (outcome) => {
  const write = pending<Response>(); let current = overview()
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string) as AutomationRequest
    if (request.method === 'overview') return reply(current)
    if (request.method === 'content') return reply([])
    return write.promise
  })
  render(<NativePanel sessionId="one" page="github-subscriptions" visible={true} refreshMs={5000} t={t} openTab={vi.fn()} />)
  await ready(); await click(t('sync')); await click(t('content')); await screen.findByText(t('empty'))
  current = { ...overview(), project: { id: 'new', title: 'Changed' }, subscriptions: [], plans: [], runs: [] }
  await click(t('refresh'), screen.getByRole('banner'))
  expect(screen.queryByRole('button', { name: t('back') })).toBeNull()
  await act(async () => { if (outcome === 'resolve') write.resolve(reply(subscription())); else write.reject(new Error('old-write')) })
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByText(t('saved'))).toBeNull()
})

it('clears a former project view when the host no longer resolves the session to a project', async () => {
  const state = bench()
  render(<NativePanel sessionId="one" page="github-subscriptions" visible={true} refreshMs={5000} t={t} openTab={vi.fn()} />)
  await ready(); await click(t('add')); state.fail = 'PROJECT_NOT_REGISTERED'
  await click(t('refresh'), screen.getByRole('banner'))
  expect(screen.getByRole('alert').textContent).toContain(t('noProject'))
  expect(screen.queryByRole('article')).toBeNull(); expect(screen.queryByRole('form')).toBeNull()
})
