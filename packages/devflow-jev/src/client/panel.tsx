/* oxlint-disable @stylistic/max-len */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { EvaluationRecord, EvaluationSummary } from '../types.ts'
import { request } from './api.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'
export interface Props { sessionId: string; visible: boolean; refreshMs: number; t: Translate }
export function JudgementPanel(props: Props) { return props.sessionId.trim() === '' ? <p>{props.t('noProject')}</p> : <ProjectPanel key={props.sessionId} {...props} /> }
function ProjectPanel({ sessionId, visible, refreshMs, t }: Props) {
  const [items, setItems] = useState<EvaluationSummary[]>(); const [selected, setSelected] = useState<EvaluationRecord>(); const [form, setForm] = useState(false)
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false)
  const alive = useRef(true); const reading = useRef<AbortController>()
  const refresh = useCallback(async () => { if (reading.current !== undefined) return; const controller = new AbortController(); reading.current = controller
    try { const next = await request({ method: 'list', sessionId }, controller.signal); if (!controller.signal.aborted && alive.current) { setItems(next); setError('') } }
    catch (failure) { if (!controller.signal.aborted && alive.current) setError(String(failure)) } finally { if (reading.current === controller) reading.current = undefined }
  }, [sessionId])
  useEffect(() => () => { alive.current = false; reading.current?.abort() }, [])
  useEffect(() => { if (!visible) return; const run = () => { if (document.visibilityState !== 'hidden') void refresh() }; run(); const timer = window.setInterval(run, refreshMs); document.addEventListener('visibilitychange', run); return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', run); reading.current?.abort(); reading.current = undefined } }, [visible, refreshMs, refresh])
  const open = async (id: string) => { setBusy(true); setError(''); try { setSelected(await request({ method: 'read', sessionId, id })) } catch (failure) { setError(String(failure)) } finally { setBusy(false) } }
  const action = async (method: 'accept' | 'reject') => { if (selected === undefined) return; setBusy(true); setError(''); try { setSelected(await request({ method, sessionId, id: selected.id })); setNotice(t('saved')); await refresh() } catch (failure) { setError(String(failure)) } finally { setBusy(false) } }
  const assess = async (title: string, body: string) => { setBusy(true); setError(''); try { const record = await request({ method: 'assess', sessionId, title, body }); setForm(false); setSelected(record); setNotice(t('saved')); await refresh() } catch (failure) { setError(String(failure)) } finally { setBusy(false) } }
  return <section className={css.page} aria-label={t('title')}><header className={css.header}><h2>{t('title')}</h2><div className={css.actions}><button onClick={() => { setForm(true) }}>{t('newAssessment')}</button><button onClick={() => void refresh()}>{t('refresh')}</button></div></header><div className={css.body}>
    {error !== '' && <div role="alert" className={css.error}>{items !== undefined && <p>{t('stale')}</p>}{error}</div>}{notice !== '' && <p role="status" className={css.notice}>{notice}</p>}
    {form && <AssessmentForm busy={busy} t={t} close={() => { setForm(false) }} submit={assess} />}
    {selected !== undefined ? <Detail value={selected} busy={busy} t={t} back={() => { setSelected(undefined) }} accept={() => void action('accept')} reject={() => void action('reject')} /> : items === undefined ? <p>{t('loading')}</p> : items.length === 0 ? <p>{t('empty')}</p> : items.map(item => <button className={css.card} key={item.id} onClick={() => void open(item.id)}><div className={css.row}><h3>{item.subject.title}</h3><span className={css.badge}>{item.status} · {item.decision}</span></div><p className={css.note}>{item.assessmentKind} · {Math.round(item.confidence * 100)}% · {new Date(item.createdAt).toLocaleString()}</p></button>)}
  </div></section>
}
function AssessmentForm({ busy, t, close, submit }: { busy: boolean; t: Translate; close: () => void; submit: (title: string, body: string) => Promise<void> }) {
  const [title, setTitle] = useState(''); const [body, setBody] = useState('')
  const send = (event: FormEvent) => { event.preventDefault(); void submit(title, body) }
  return <form className={css.form} onSubmit={send}><label>{t('titleField')}<input required value={title} onChange={(event) => { setTitle(event.target.value) }} /></label><label>{t('body')}<textarea required value={body} onChange={(event) => { setBody(event.target.value) }} /></label><div className={css.actions}><button disabled={busy}>{t('assess')}</button><button type="button" onClick={close}>{t('close')}</button></div></form>
}
function Detail({ value, busy, t, back, accept, reject }: { value: EvaluationRecord; busy: boolean; t: Translate; back: () => void; accept: () => void; reject: () => void }) {
  return <article className={`${css.card} ${css.detail}`}><button onClick={back}>{t('back')}</button><div className={css.row}><h3>{value.subject.title}</h3><span className={css.badge}>{value.status} · {value.decision}</span></div><p>{t('confidence')}: {Math.round(value.confidence * 100)}%</p><h3>{t('reasons')}</h3><ul>{value.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>{value.missingInformation.length > 0 && <><h3>{t('missing')}</h3><ul>{value.missingInformation.map(reason => <li key={reason}>{reason}</li>)}</ul></>}{value.error !== undefined && <p className={css.error}>{t('unavailable')}: [{value.error.code}] {value.error.message}</p>}{value.createdCardId !== undefined && <p>{t('createdCard')}: {value.createdCardId}</p>}<details><summary>{t('answers')}</summary><pre>{JSON.stringify(value.answers, null, 2)}</pre></details>{value.status === 'review' && value.decision === 'propose' && <div className={css.actions}><button disabled={busy} onClick={accept}>{t('accept')}</button><button disabled={busy} onClick={reject}>{t('reject')}</button></div>}</article>
}
