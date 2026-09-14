import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { automationRequest, type AutomationRequest, type Overview } from '@zhchxiao123/dsh-automation-web/client'
import type { Plan } from '@zhchxiao123/dsh-scheduler'
import type { Snapshot, Subscription } from '@zhchxiao123/dsh-github-sync'
import { PlanForm, SubscriptionForm } from './forms.tsx'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

type Section = 'subscriptions' | 'plans' | 'runs'
type Editor = { kind: 'subscription'; item: Subscription | undefined } | { kind: 'plan'; item: Plan | undefined }
const sections: readonly Section[] = ['subscriptions', 'plans', 'runs']
const activeRuns = new Set(['queued', 'running', 'waiting'])
const activeTriggers = new Set(['pending', 'delivering', 'accepted'])

/** Unsafe external schemes remain plain text; content never becomes markup. */
export function sourceURL(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch { return undefined } // Invalid external URLs remain text, just like unsupported schemes.
}

/** The slot controls visibility; hidden panes neither poll nor retain an in-flight read. */
export function AutomationPanel({ visible, refreshMs, t }: { visible: boolean; refreshMs: number; t: Translate }) {
  const [overview, setOverview] = useState<Overview>()
  const [error, setError] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [contentError, setContentError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState<Section>('subscriptions')
  const [editor, setEditor] = useState<Editor>()
  const [contentId, setContentId] = useState<string>()
  const [content, setContent] = useState<Snapshot[]>()
  const [capacity, setCapacity] = useState('')
  const [removing, setRemoving] = useState<string>()
  const alive = useRef(true)
  const read = useRef<AbortController>()
  const contentRead = useRef<AbortController>()
  const writing = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    if (read.current !== undefined) return
    const controller = new AbortController()
    read.current = controller
    try {
      const next = await automationRequest({ method: 'overview' }, controller.signal)
      if (!controller.signal.aborted && alive.current) { setOverview(next); setError('') }
    } catch (failure) {
      if (!controller.signal.aborted && alive.current) { setError(String(failure)) }
    } finally {
      if (read.current === controller) read.current = undefined
    }
  }, [])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; read.current?.abort(); contentRead.current?.abort() }
  }, [])
  useEffect(() => {
    if (!visible) return
    const refreshVisible = (): void => { if (document.visibilityState !== 'hidden') void refresh() }
    refreshVisible()
    const timer = window.setInterval(refreshVisible, refreshMs)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); read.current?.abort(); read.current = undefined }
  }, [visible, refreshMs, refresh])
  const refreshContent = useCallback(async (id: string): Promise<void> => {
    if (contentRead.current !== undefined) return
    const controller = new AbortController()
    contentRead.current = controller
    try {
      const items = await automationRequest({ method: 'content', subscriptionId: id }, controller.signal)
      if (!controller.signal.aborted) { setContent(items); setContentError('') }
    } catch (failure) {
      if (!controller.signal.aborted) setContentError(String(failure))
    } finally {
      if (contentRead.current === controller) contentRead.current = undefined
    }
  }, [])
  useEffect(() => {
    if (contentId === undefined || !visible) return
    const refreshVisible = (): void => { if (document.visibilityState !== 'hidden') void refreshContent(contentId) }
    refreshVisible()
    const timer = window.setInterval(refreshVisible, refreshMs)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible)
      contentRead.current?.abort(); contentRead.current = undefined
    }
  }, [contentId, visible, refreshMs, refreshContent])
  const act = (request: AutomationRequest): void => {
    if (writing.current) return
    writing.current = true
    setBusy(true); setMutationError(''); setNotice('')
    void automationRequest(request).then(async () => {
      if (!alive.current) return
      setEditor(undefined); setRemoving(undefined); setNotice(t('saved'))
      await refresh()
    }, (failure: unknown) => { if (alive.current) setMutationError(String(failure)) }).finally(() => {
      writing.current = false
      if (alive.current) setBusy(false)
    })
  }
  const showContent = (id: string): void => { setContent(undefined); setContentError(''); setContentId(id) }
  const close = (): void => { setEditor(undefined) }
  const retry = (): void => { void refresh(); if (contentId !== undefined) void refreshContent(contentId) }
  const saveCapacity = (event: FormEvent): void => { event.preventDefault(); act({ method: 'capacity.set', bytes: Number(capacity) }) }
  const selectSection = (next: Section): void => { setSection(next); setEditor(undefined); setContentId(undefined); setRemoving(undefined) }
  return <section className={css.page} aria-label={t('title')}>
    <header className={css.header}><h2>{t('title')}</h2><button onClick={retry}>{t('refresh')}</button></header>
    <nav className={css.tabs} aria-label={t('title')}>{sections.map(key => <button key={key} aria-pressed={section === key} onClick={() =>{  selectSection(key) }}>{t(key)}</button>)}</nav>
    <div className={css.body}>
      <p className={css.note}>{t('scope')}</p>
      {error !== '' && <div role="alert" className={css.error}>{overview !== undefined && <p>{t('stale')}</p>}{error}<button onClick={retry}>{t('refresh')}</button></div>}
      {mutationError !== '' && <div role="alert" className={css.error}>{mutationError}<button onClick={() => { setMutationError('') }}>{t('close')}</button></div>}
      {contentId !== undefined && contentError !== '' && <div role="alert" className={css.error}>{contentError}<button onClick={retry}>{t('refresh')}</button></div>}
      {notice !== '' && <p role="status">{notice}</p>}
      {overview === undefined ? error === '' && <p role="status">{t('loading')}</p> : <>
        {section === 'subscriptions' && <>
          {!overview.githubAvailable ? <p>{t('unavailable')}</p> : <>
            <button onClick={() =>{  setEditor({ kind: 'subscription', item: undefined }) }}>{t('add')}</button>
            {editor?.kind === 'subscription' && <SubscriptionForm key={editor.item?.id ?? 'new'} item={editor.item} t={t} busy={busy} submit={act} close={close} />}
            {contentId !== undefined ? <div className={css.card}><button onClick={() =>{  setContentId(undefined) }}>{t('back')}</button><h3>{t('content')}</h3>{content === undefined ? <p>{t('loading')}</p> : content.length === 0 ? <p>{t('empty')}</p> : content.map(item => <Content key={item.id} item={item} t={t} />)}</div> : <>
              {overview.subscriptions.length === 0 && <p>{t('empty')}</p>}
              {overview.subscriptions.map(item => <article className={css.card} key={item.id} aria-label={item.repository}>
                <div className={css.row}><h3>{item.repository}</h3><span className={css.badge}>{t(item.paused ? 'paused' : 'enabled')}</span></div>
                <p className={css.note}>{[item.issues && 'Issues', item.discussions && 'Discussions'].filter(Boolean).join(' · ')} · {item.id}</p>
                {item.lastSuccessAt !== undefined && <p className={css.note}>{t('lastSuccess')}: {new Date(item.lastSuccessAt).toLocaleString()}</p>}
                {overview.plans.filter(plan => plan.handler === 'github.sync' && linkedSubscription(plan.params) === item.id).map(plan => <button key={plan.id} onClick={() => { selectSection('plans') }}>{plan.name}</button>)}
                <div className={css.actions}><button disabled={busy} onClick={() =>{  act({ method: 'subscription.action', id: item.id, action: 'sync' }) }}>{t('sync')}</button><button disabled={busy} onClick={() =>{  act({ method: 'subscription.action', id: item.id, action: item.paused ? 'resume' : 'pause' }) }}>{t(item.paused ? 'resume' : 'pause')}</button><button onClick={() =>{  setEditor({ kind: 'subscription', item }) }}>{t('edit')}</button><button onClick={() =>{  showContent(item.id) }}>{t('content')}</button></div>
              </article>)}
            </>}
            {overview.storage !== null && <details className={css.card}><summary>{t('storage')} · {overview.storage.bytes.toLocaleString()} / {overview.storage.capacityBytes.toLocaleString()} B</summary>
              {overview.storage.blocked && <p role="status">{t('blocked')}</p>}
              {overview.storage.error !== undefined && <p>{overview.storage.error}</p>}
              <form className={css.form} onSubmit={saveCapacity}><label>{t('capacity')}<input type="number" min="1" step="1" required placeholder={String(overview.storage.capacityBytes)} value={capacity} onChange={(event) =>{  setCapacity(event.target.value) }} /></label><button disabled={busy}>{t('save')}</button></form>
            </details>}
          </>}
        </>}
        {section === 'plans' && <>
          {!overview.schedulerAvailable ? <p>{t('unavailable')}</p> : <>
            <button disabled={!overview.githubAvailable || overview.subscriptions.length === 0} onClick={() =>{  setEditor({ kind: 'plan', item: undefined }) }}>{t('add')}</button>
            {editor?.kind === 'plan' && <PlanForm key={editor.item?.id ?? 'new'} item={editor.item} subscriptions={overview.subscriptions} t={t} busy={busy} submit={act} close={close} />}
            {overview.plans.length === 0 && <p>{t('empty')}</p>}
            {overview.plans.map(item => <article className={css.card} key={item.id} aria-label={item.name}>
              <div className={css.row}><h3>{item.name}</h3><span className={css.badge}>{t(item.enabled ? 'enabled' : 'paused')}</span></div>
              <p>{item.rule.kind === 'interval' ? `${item.rule.everyMs / 60_000} ${t('minutes')}` : `${item.rule.expression} · ${item.rule.timezone}`}</p><p className={css.note}>{t('next')}: {new Date(item.nextAt).toLocaleString()} · {item.handler}</p>
              <div className={css.actions}><button disabled={busy} onClick={() =>{  act({ method: 'plan.action', id: item.id, action: 'trigger' }) }}>{t('trigger')}</button><button disabled={busy} onClick={() =>{  act({ method: 'plan.action', id: item.id, action: item.enabled ? 'pause' : 'resume' }) }}>{t(item.enabled ? 'pause' : 'resume')}</button><button onClick={() =>{  setEditor({ kind: 'plan', item }) }}>{t('edit')}</button><button onClick={() =>{  setRemoving(item.id) }}>{t('remove')}</button></div>
              {removing === item.id && <div><p>{t('removeHint')}</p><button disabled={busy} onClick={() =>{  act({ method: 'plan.action', id: item.id, action: 'remove' }) }}>{t('confirmRemove')}</button><button onClick={() =>{  setRemoving(undefined) }}>{t('close')}</button></div>}
            </article>)}
          </>}
        </>}
        {section === 'runs' && <>
          {!overview.githubAvailable && !overview.schedulerAvailable && <p>{t('unavailable')}</p>}
          {overview.runs.length === 0 && overview.triggers.length === 0 && <p>{t('empty')}</p>}
          {overview.runs.map(run => <article className={css.card} key={run.id}>
            <div className={css.row}><h3>{run.subscriptionSnapshot.repository}</h3><span className={css.badge}>{t(run.status)}</span></div>
            <p>{run.pages} {t('pages')} · {run.objects} {t('objects')} · {run.retries} {t('retries')}</p>
            <dl><dt>{t('started')}</dt><dd>{new Date(run.acceptedAt).toLocaleString()}</dd>{run.completedAt !== undefined && <><dt>{t('completed')}</dt><dd>{new Date(run.completedAt).toLocaleString()}</dd></>}{run.waitUntil !== undefined && <><dt>{t('wait')}</dt><dd>{new Date(run.waitUntil).toLocaleString()}</dd></>}</dl>
            {run.error !== undefined && <p className={css.error}>{run.error}</p>}
            <details><summary>{t('detail')}</summary><p>{run.id}</p><p>{run.triggerId}</p><button onClick={() => { selectSection('subscriptions'); showContent(run.subscriptionId) }}>{t('content')}</button></details>
            <div className={css.actions}>{activeRuns.has(run.status) && <button disabled={busy} onClick={() =>{  act({ method: 'run.action', id: run.id, action: 'cancel' }) }}>{t('cancel')}</button>}{(run.status === 'failed' || run.status === 'partial') && <button disabled={busy} onClick={() =>{  act({ method: 'run.action', id: run.id, action: 'resume' }) }}>{t('resume')}</button>}</div>
          </article>)}
          {overview.triggers.map(trigger => <article className={css.card} key={trigger.id}>
            <div className={css.row}><h3>{overview.plans.find(plan => plan.id === trigger.planId)?.name ?? trigger.planId}</h3><span className={css.badge}>{t(trigger.state === 'completed' ? 'succeeded' : trigger.state)}</span></div>
            <p className={css.note}>{new Date(trigger.scheduledAt).toLocaleString()} · {trigger.id}</p>
            {trigger.runId !== undefined && <p>{trigger.runId}</p>}
            {trigger.error !== undefined && <p className={css.error}>{trigger.error}</p>}
            <button onClick={() =>{  selectSection('plans') }}>{t('plans')}</button>{activeTriggers.has(trigger.state) && <button disabled={busy} onClick={() =>{  act({ method: 'plan.action', id: trigger.id, action: 'cancel' }) }}>{t('cancel')}</button>}
          </article>)}
        </>}
      </>}
    </div>
  </section>
}

/** Parameters belong to arbitrary handlers; only a recognized GitHub payload supplies a backlink. */
function linkedSubscription(params: unknown): unknown {
  return typeof params === 'object' && params !== null && 'subscriptionId' in params ? params.subscriptionId : undefined
}

function Content({ item, t }: { item: Snapshot; t: Translate }) {
  const url = sourceURL(item.url)
  return <article className={css.card}><h3>{item.title}</h3><p className={css.note}>{item.kind} · {item.state} · v{item.version}</p><pre>{item.body}</pre>{url === undefined ? <span>{item.url}</span> : <a href={url} target="_blank" rel="noopener noreferrer">{t('source')}</a>}</article>
}
