import { useEffect, useRef, useState } from 'react'
import { automationRequest } from '@zhchxiao123/dsh-automation-web/client'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** Legacy records are revealed on demand and only move after an explicit claim. */
export function Unassigned({ sessionId, kind, t, changed }: { sessionId: string; kind: 'plan' | 'subscription'; t: Translate; changed: () => Promise<void> }) {
  const [items, setItems] = useState<{ id: string; label: string }[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const read = async (): Promise<void> => {
    const data = await automationRequest({ method: 'unassigned', sessionId })
    if (active.current) setItems(kind === 'plan' ? data.plans.map(item => ({ id: item.id, label: item.name })) : data.subscriptions.map(item => ({ id: item.id, label: item.repository })))
  }
  const execute = (id?: string): void => {
    setBusy(true); setError('')
    void (async () => {
      if (id !== undefined) {
        await automationRequest({ method: 'claim', sessionId, kind, id })
        if (!active.current) return
        await changed()
      }
      if (active.current) await read()
    })().catch((failure: unknown) => { if (active.current) setError(String(failure)) }).finally(() => {
      if (active.current) setBusy(false)
    })
  }
  return <details className={css.card}><summary>{t('unassigned')}</summary><p>{t('claimHint')}</p>
    <button disabled={busy} onClick={() => { execute() }}>{t('refresh')}</button>
    {error !== '' && <p role="alert">{error}</p>}
    {items?.length === 0 && <p>{t('empty')}</p>}
    {items?.map(item => <div key={item.id}><span>{item.label}</span><button disabled={busy} onClick={() => { execute(item.id) }}>{t('claim')}</button></div>)}
  </details>
}
