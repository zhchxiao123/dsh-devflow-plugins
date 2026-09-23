import { useState, type FormEvent } from 'react'
import type { AssessmentKind, AuditProfile } from '../types.ts'
import type { Translate } from './locales.ts'
import { assessmentLabel, label, profiles, profileHint } from './presentation.ts'
import css from './panel.module.css'
const assessmentKinds: readonly AssessmentKind[] = ['intake', 'planning', 'implementation-risk', 'test-impact', 'review-scope', 'release-readiness', 'spec-delta']
type Mode = 'audit' | 'request' | 'generic' | 'card'
export function ReviewForm({
  busy, t, audit, assess, generic, assessCard, genericAvailable,
}: {
  busy: boolean
  t: Translate
  audit: (profile: AuditProfile, maxCards: number) => void
  assess: (title: string, body: string) => void
  generic: (title: string, evidence: string, questions: string[]) => void
  assessCard: (id: string, assessmentKind: AssessmentKind) => void
  genericAvailable: boolean
}) {
  const [mode, setMode] = useState<Mode>('audit')
  const [profile, setProfile] = useState<AuditProfile>('delivery-health')
  const [maxCards, setMaxCards] = useState('50')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reviewTitle, setReviewTitle] = useState('')
  const [evidence, setEvidence] = useState('')
  const [questions, setQuestions] = useState('')
  const [cardId, setCardId] = useState('')
  const [assessmentKind, setAssessmentKind] = useState<AssessmentKind>('planning')
  const checklist = questions.split('\n').map(value => value.trim()).filter(Boolean)
  const invalid = mode === 'generic'
    ? !genericAvailable || reviewTitle.trim() === '' || evidence.trim() === '' || checklist.length === 0
    : mode === 'request' ? title.trim() === '' || body.trim() === ''
      : mode === 'card' ? cardId.trim() === '' : !Number.isInteger(Number(maxCards)) || Number(maxCards) < 1 || Number(maxCards) > 200
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || invalid) return
    switch (mode) {
      case 'audit': audit(profile, Number(maxCards)); break
      case 'request': assess(title.trim(), body.trim()); break
      case 'generic': generic(reviewTitle.trim(), evidence.trim(), checklist); break
      case 'card': assessCard(cardId.trim(), assessmentKind); break
    }
  }
  return (
    <div className={css.detail}>
      <h2>{t('newReview')}</h2>
      <div className={css.filters} aria-label={t('newReview')}>
        {(['audit', 'generic', 'request', 'card'] as const).map(value => (
          <button key={value} className={css.filter} disabled={busy || (value === 'generic' && !genericAvailable)}
            aria-pressed={mode === value} onClick={() => { setMode(value) }}>
            {t(value === 'audit' ? 'audits' : value === 'generic' ? 'runs' : value === 'request' ? 'newAssessment' : 'assessExisting')}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className={css.form}>
        {mode === 'audit' ? (
          <>
            <p className={css.scope}>{t('auditScope')}</p>
            <label>{t('profile')}
              <select value={profile} onChange={(event) => { setProfile(event.target.value as AuditProfile) }}>
                {profiles.map(value => <option key={value} value={value}>{label(value, t)}</option>)}
              </select>
            </label>
            <p className={css.muted}>{profileHint(profile, t)}</p>
            <label>{t('maxCards')}
              <input type="number" min="1" max="200" step="1" required value={maxCards}
                onChange={(event) => { setMaxCards(event.target.value) }} />
            </label>
          </>
        ) : mode === 'generic' ? (
          <>
            <p className={css.scope}>{t('genericFormScope')}</p>
            <label>{t('reviewTitle')}<input required value={reviewTitle} onChange={(event) => { setReviewTitle(event.target.value) }} /></label>
            <label>{t('evidence')}<textarea required rows={8} value={evidence} onChange={(event) => { setEvidence(event.target.value) }} /></label>
            <label>{t('checklistQuestions')}<textarea required rows={5} value={questions}
              placeholder={t('questionsExample')} onChange={(event) => { setQuestions(event.target.value) }} /></label>
            <p className={css.muted}>{t('questionsHint')}</p>
          </>
        ) : mode === 'card' ? (
          <>
            <p className={css.scope}>{t('cardAssessmentHint')}</p>
            <label>{t('cardId')}<input required value={cardId} onChange={(event) => { setCardId(event.target.value) }} /></label>
            <label>{t('assessmentKind')}<select value={assessmentKind}
              onChange={(event) => { setAssessmentKind(event.target.value as AssessmentKind) }}>
              {assessmentKinds.map(value => <option key={value} value={value}>{assessmentLabel(value, t)}</option>)}
            </select></label>
          </>
        ) : (
          <>
            <p className={css.scope}>{t('assessmentHint')}</p>
            <label>{t('titleField')}<input required value={title} onChange={(event) => { setTitle(event.target.value) }} /></label>
            <label>{t('body')}<textarea required rows={6} value={body} onChange={(event) => { setBody(event.target.value) }} /></label>
          </>
        )}
        <button className={css.primary} disabled={busy || invalid}>
          {busy ? t('loading') : t(mode === 'audit' ? 'startAudit' : mode === 'generic' ? 'startGeneric' : 'assess')}
        </button>
      </form>
      <div className={css.callout}>
        <strong>{t('genericCreate')}</strong>
        <p>{t('genericHint')}</p>
      </div>
    </div>
  )
}
