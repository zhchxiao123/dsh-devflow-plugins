import type { Answer, JevRequest } from '@zhchxiao123/dsh-jev'
import type { ReactNode } from 'react'
import type { Translate } from './locales.ts'
import { label, percent, questionLabel, resumable, tone } from './presentation.ts'
import css from './panel.module.css'
export function Badge({ value, t }: { value: string; t: Translate }) {
  return (
    <span className={css.badge} data-tone={tone(value)}>
      {label(value, t)}
    </span>
  )
}
export function Raw({ value, t }: { value: unknown; t: Translate }) {
  return (
    <details className={css.disclosure}>
      <summary>{t('technical')}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}
export function ErrorNotice({
  errors,
  stale = false,
  t,
}: {
  errors: readonly string[]
  stale?: boolean
  t: Translate
}) {
  if (errors.length === 0) return null
  const text = errors.join('\n')
  return (
    <div role="alert" className={css.alert} data-tone="danger">
      <strong>{t(stale ? 'stale' : 'actionError')}</strong>
      {text.includes('LIVE_SESSION_REQUIRED') && <p>{t('liveRequired')}</p>}
      {text.includes('owner') && <p>{t('denied')}</p>}
      <details>
        <summary>{t('errorDetail')}</summary>
        <pre>{text}</pre>
      </details>
    </div>
  )
}
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={css.section}>
      <h3>{title}</h3>
      {children}
    </section>
  )
}
export function Progress({ state, t }: { state: { total: number; completed: number; failed: number }; t: Translate }) {
  return (
    <div className={css.progressBlock}>
      <div className={css.row}>
        <span>{t('processed')}</span>
        <strong>
          {state.completed} / {state.total}
        </strong>
      </div>
      <progress aria-label={t('progress')} max={Math.max(1, state.total)} value={state.completed} />
      <div className={css.metrics}>
        <span>
          {t('succeeded')} <strong>{Math.max(0, state.completed - state.failed)}</strong>
        </span>
        <span>
          {t('errors')} <strong>{state.failed}</strong>
        </span>
        <span>
          {t('remaining')} <strong>{Math.max(0, state.total - state.completed)}</strong>
        </span>
      </div>
      <p className={css.muted}>{state.total === 0 ? t('noChecks') : t('executionHint')}</p>
    </div>
  )
}
export function NextStep({
  status,
  busy,
  control,
  t,
}: {
  status: string
  busy: boolean
  control: (action: 'resume' | 'cancel') => void
  t: Translate
}) {
  return (
    <div className={css.callout}>
      <strong>{t('next')}</strong>
      <p>{t(resumable(status) ? 'resumeHint' : status === 'running' ? 'runningHint' : 'completedHint')}</p>
      {resumable(status) && (
        <button
          className={css.primary}
          disabled={busy}
          onClick={() => {
            control('resume')
          }}
        >
          {t('resumeAudit')}
        </button>
      )}
      {status === 'running' && (
        <button
          className={css.button}
          disabled={busy}
          onClick={() => {
            control('cancel')
          }}
        >
          {t('cancelAudit')}
        </button>
      )}
    </div>
  )
}
export function Answers({
  answers,
  request: definition,
  t,
}: {
  answers: Readonly<Record<string, Answer>>
  request?: JevRequest
  t: Translate
}) {
  const keys = definition === undefined ? Object.keys(answers) : Object.keys(definition.questions)
  return (
    <div className={css.stack}>
      {keys.map((key) => {
        const answer = answers[key]
        const question = definition?.questions[key]
        const choiceDescription =
          answer?.type === 'choice' && question?.type === 'choice' ? question.criteria[answer.choice] : undefined
        const title =
          typeof question?.instructions === 'string'
            ? question.instructions
            : definition === undefined
              ? questionLabel(key, t)
              : key
        return (
          <div className={css.answer} key={key}>
            <strong>{title}</strong>
            {answer === undefined ? (
              <p>{t('answerMissing')}</p>
            ) : (
              <>
                <p className={css.answerValue}>
                  {answer.type === 'noul'
                    ? `${t('yesProbability')} · ${percent(answer.noul)}`
                    : answer.type === 'choice'
                      ? `${t('selected')} · ${definition === undefined ? label(answer.choice, t) : answer.choice}`
                      : `${t('score')} · ${Number(answer.score.toFixed(2))} / ${question?.type === 'score' ? question.criteria.length - 1 : answer.probabilities.length - 1}`}
                </p>
                {typeof choiceDescription === 'string' && <p className={css.prose}>{choiceDescription}</p>}
                {answer.type !== 'noul' && (
                  <span className={css.muted}>
                    {t('confidence')} {percent(answer.confidence)}
                  </span>
                )}
              </>
            )}
            {question !== undefined && (
              <details>
                <summary>{t('question')}</summary>
                {typeof question.instructions !== 'string' && (
                  <pre>{JSON.stringify(question.instructions, null, 2)}</pre>
                )}
                <dl className={css.rubric}>
                  {Object.entries(question.criteria ?? {}).map(([option, description]) => (
                    <div key={option}>
                      <dt>{option}</dt>
                      <dd>
                        {typeof description === 'string'
                          ? description
                          : description === null
                            ? '—'
                            : JSON.stringify(description)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
