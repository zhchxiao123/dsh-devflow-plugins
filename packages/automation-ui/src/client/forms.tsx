import { useState, type FormEvent } from 'react'
import type { Plan } from '@zhchxiao123/dsh-scheduler'
import type { Subscription } from '@zhchxiao123/dsh-github-sync'
import type { AutomationRequest } from '@zhchxiao123/dsh-automation-web/client'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

type WithoutSession<T> = T extends unknown ? Omit<T, 'sessionId'> : never
export type FormRequest = WithoutSession<AutomationRequest>
export interface FormProps { t: Translate; busy: boolean; submit: (request: FormRequest) => void; close: () => void }

/** Repository identity stays fixed while scope and credential references can change. */
export function SubscriptionForm({ item, t, busy, submit, close }: FormProps & { item: Subscription | undefined }) {
  const [repository, setRepository] = useState(item?.repository ?? '')
  const [credentialRef, setCredential] = useState(item?.credentialRef ?? '')
  const [issues, setIssues] = useState(item?.issues ?? true)
  const [discussions, setDiscussions] = useState(item?.discussions ?? false)
  const save = (event: FormEvent): void => {
    event.preventDefault()
    submit({ method: 'subscription.save', ...(item === undefined ? {} : { id: item.id }), input: { repository, issues, discussions, ...(credentialRef.trim() === '' ? {} : { credentialRef: credentialRef.trim() }) } })
  }
  return <form className={css.form} onSubmit={save} aria-label={t('subscriptions')}>
    <label>{t('repository')}<input required value={repository} disabled={item !== undefined} onChange={(event) =>{  setRepository(event.target.value) }} pattern="[^/\s]+/[^/\s]+" /></label>
    <label>{t('credential')}<input value={credentialRef} onChange={(event) =>{  setCredential(event.target.value) }} placeholder="env:GITHUB_TOKEN" pattern="env:[A-Za-z_][A-Za-z0-9_]*" /></label>
    <label className={css.check}><input type="checkbox" checked={issues} onChange={(event) =>{  setIssues(event.target.checked) }} />{t('issues')}</label>
    <label className={css.check}><input type="checkbox" checked={discussions} onChange={(event) =>{  setDiscussions(event.target.checked) }} />{t('discussions')}</label>
    <div className={css.actions}><button disabled={busy || (!issues && !discussions)}>{t('save')}</button><button type="button" onClick={close}>{t('close')}</button></div>
  </form>
}

/** Existing handler parameters are opaque and survive a schedule-only edit verbatim. */
export function PlanForm(
  { item, subscriptions, initialSubscriptionId, t, busy, submit, close }: FormProps & {
    item: Plan | undefined
    subscriptions: readonly Subscription[]
    initialSubscriptionId?: string | undefined
  },
) {
  const [name, setName] = useState(item?.name ?? '')
  const [selected, setSelected] = useState(initialSubscriptionId ?? subscriptions[0]?.id ?? '')
  const [kind, setKind] = useState(item?.rule.kind ?? 'interval')
  const [minutes, setMinutes] = useState(item?.rule.kind === 'interval' ? String(item.rule.everyMs / 60_000) : '120')
  const [expression, setExpression] = useState(item?.rule.kind === 'cron' ? item.rule.expression : '0 */2 * * *')
  const [timezone, setTimezone] = useState(item?.rule.kind === 'cron' ? item.rule.timezone : 'UTC')
  const save = (event: FormEvent): void => {
    event.preventDefault()
    submit({ method: 'plan.save', ...(item === undefined ? {} : { id: item.id }), input: {
      ...(item === undefined ? { handler: 'github.sync', params: { subscriptionId: selected } } : { handler: item.handler, params: item.params, ...(item.misfire === undefined ? {} : { misfire: item.misfire }), ...(item.maxAttempts === undefined ? {} : { maxAttempts: item.maxAttempts }), ...(item.timeoutMs === undefined ? {} : { timeoutMs: item.timeoutMs }) }),
      name, rule: kind === 'interval' ? { kind, everyMs: Number(minutes) * 60_000 } : { kind, expression, timezone },
    } })
  }
  return <form className={css.form} onSubmit={save} aria-label={t('plans')}>
    <label>{t('name')}<input required value={name} onChange={(event) =>{  setName(event.target.value) }} /></label>
    {item === undefined ? <label>{t('subscription')}<select required value={selected} onChange={(event) =>{  setSelected(event.target.value) }}><option value="" disabled>{t('subscription')}</option>{subscriptions.map(sub => <option key={sub.id} value={sub.id}>{sub.repository}</option>)}</select></label> : <p className={css.note}>{item.handler} · {t('generic')}</p>}
    <label>{t('rule')}<select value={kind} onChange={(event) =>{  setKind(event.target.value === 'cron' ? 'cron' : 'interval') }}><option value="interval">{t('interval')}</option><option value="cron">{t('cron')}</option></select></label>
    {kind === 'interval' ? <label>{t('minutes')}<input required type="number" min="0.001" step="any" value={minutes} onChange={(event) =>{  setMinutes(event.target.value) }} /></label> : <><label>{t('expression')}<input required value={expression} onChange={(event) =>{  setExpression(event.target.value) }} /></label><label>{t('timezone')}<input required value={timezone} onChange={(event) =>{  setTimezone(event.target.value) }} /></label></>}
    <div className={css.actions}><button disabled={busy || (item === undefined && selected === '')}>{t('save')}</button><button type="button" onClick={close}>{t('close')}</button></div>
  </form>
}
