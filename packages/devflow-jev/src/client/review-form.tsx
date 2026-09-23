import { useState, type FormEvent } from 'react'
import type { AuditProfile } from '../types.ts'
import type { Translate } from './locales.ts'
import { label, profiles, profileHint } from './presentation.ts'
import css from './panel.module.css'
export function ReviewForm({
  busy,
  t,
  audit,
  assess,
}: {
  busy: boolean
  t: Translate
  audit: (profile: AuditProfile, maxCards: number) => void
  assess: (title: string, body: string) => void
}) {
  const [mode, setMode] = useState<'audit' | 'request'>('audit')
  const [profile, setProfile] = useState<AuditProfile>('delivery-health')
  const [maxCards, setMaxCards] = useState('50')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (mode === 'audit') audit(profile, Number(maxCards))
    else assess(title.trim(), body.trim())
  }
  return (
    <div className={css.detail}>
      <h2>{t('newReview')}</h2>
      <div className={css.filters} aria-label={t('newReview')}>
        <button
          className={css.filter}
          aria-pressed={mode === 'audit'}
          onClick={() => {
            setMode('audit')
          }}
        >
          {t('audits')}
        </button>
        <button
          className={css.filter}
          aria-pressed={mode === 'request'}
          onClick={() => {
            setMode('request')
          }}
        >
          {t('newAssessment')}
        </button>
      </div>
      <form onSubmit={submit} className={css.form}>
        {mode === 'audit' ? (
          <>
            <p className={css.scope}>{t('auditScope')}</p>
            <label>
              {t('profile')}
              <select
                value={profile}
                onChange={(event) => {
                  setProfile(event.target.value as AuditProfile)
                }}
              >
                {profiles.map(value => (
                  <option key={value} value={value}>
                    {label(value, t)}
                  </option>
                ))}
              </select>
            </label>
            <p className={css.muted}>{profileHint(profile, t)}</p>
            <label>
              {t('maxCards')}
              <input
                type="number"
                min="1"
                max="200"
                step="1"
                required
                value={maxCards}
                onChange={(event) => {
                  setMaxCards(event.target.value)
                }}
              />
            </label>
          </>
        ) : (
          <>
            <p className={css.scope}>{t('assessmentHint')}</p>
            <label>
              {t('titleField')}
              <input
                required
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value)
                }}
              />
            </label>
            <label>
              {t('body')}
              <textarea
                required
                rows={6}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value)
                }}
              />
            </label>
          </>
        )}
        <button
          className={css.primary}
          disabled={busy || (mode === 'request' && (title.trim() === '' || body.trim() === ''))}
        >
          {busy ? t('loading') : t(mode === 'audit' ? 'startAudit' : 'assess')}
        </button>
      </form>
      <div className={css.callout}>
        <strong>{t('genericCreate')}</strong>
        <p>{t('genericHint')}</p>
      </div>
    </div>
  )
}
