import type { JevRunSnapshot } from '@zhchxiao123/dsh-jev'
import type { AuditSummary, EvaluationRecord } from '../types.ts'
import type { Translate } from './locales.ts'
import { assessmentLabel, date, label, percent, reasonText } from './presentation.ts'
import { Answers, Badge, NextStep, Progress, Raw, Section } from './review-parts.tsx'
import css from './panel.module.css'
interface RunProps {
  busy: boolean
  t: Translate
  control: (action: 'resume' | 'cancel') => void
}
export function AuditDetail({
  value,
  openEvaluation,
  ...props
}: RunProps & { value: AuditSummary; openEvaluation: (id: string) => void }) {
  const { manifest, state } = value
  const { t } = props
  return (
    <article className={css.detail}>
      <div className={css.row}>
        <span className={css.eyebrow}>{t('audits')}</span>
        <Badge value={state.status} t={t} />
      </div>
      <h2>{label(manifest.profile, t)}</h2>
      <p className={css.muted}>
        {manifest.cardCount} {t('cards')} · {date(manifest.createdAt)}
      </p>
      <p className={css.scope}>{t('auditScope')}</p>
      <Section title={t('summary')}>
        <p className={css.conclusion}>
          {state.total === 0 ? t('noChecks') : label(state.conclusion ?? 'incomplete', t)}
        </p>
      </Section>
      <Progress state={state} t={t} />
      <NextStep status={state.status} {...props} />
      <Section title={t('findings')}>
        {state.findings.length === 0 ? (
          <p className={css.muted}>{t('noFindings')}</p>
        ) : (
          <ul className={css.findings}>
            {state.findings.map((finding, index) => (
              <li key={`${finding.code}-${index}`}>
                <Badge value={finding.severity} t={t} />
                <p>{finding.message}</p>
                {finding.cardId !== undefined && (
                  <small>
                    {t('card')} {finding.cardId}
                  </small>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={`${t('checks')} · ${manifest.checks.length}`}>
        <div className={css.stack}>
          {manifest.checks.map((check) => {
            const result = state.results.find(item => item.check.id === check.id)
            const evaluationId = result?.evaluationId
            return (
              <div key={check.id} className={css.check}>
                <div className={css.row}>
                  <strong>{check.cardTitle}</strong>
                  <Badge value={result?.status === 'completed' ? 'returned' : (result?.status ?? 'pending')} t={t} />
                </div>
                <p className={css.muted}>
                  {assessmentLabel(check.assessmentKind, t)} · {check.cardId}
                </p>
                {result?.error !== undefined && <p className={css.errorText}>{result.error}</p>}
                {evaluationId !== undefined && (
                  <button
                    className={css.linkButton}
                    disabled={props.busy}
                    onClick={() => {
                      openEvaluation(evaluationId)
                    }}
                  >
                    {t('details')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </Section>
      <Raw value={value} t={t} />
    </article>
  )
}
export function GenericDetail({ value, ...props }: RunProps & { value: JevRunSnapshot }) {
  const { definition, state } = value
  const { t } = props
  return (
    <article className={css.detail}>
      <div className={css.row}>
        <span className={css.eyebrow}>{t('runs')}</span>
        <Badge value={state.status} t={t} />
      </div>
      <h2>{definition.scope.title}</h2>
      <p className={css.muted}>
        {t('template')} · {definition.template.id} · {date(definition.createdAt)}
      </p>
      <p className={css.scope}>{t('genericScope')}</p>
      <Progress state={state} t={t} />
      <NextStep status={state.status} {...props} />
      <Section title={`${t('checks')} · ${definition.checks.length}`}>
        <div className={css.stack}>
          {definition.checks.map((check) => {
            const result = state.results.find(item => item.checkId === check.id)
            return (
              <details className={css.check} key={check.id}>
                <summary>
                  <span>{check.subject.title}</span>
                  <Badge value={result?.status === 'completed' ? 'returned' : (result?.status ?? 'pending')} t={t} />
                </summary>
                {result?.error !== undefined && (
                  <p className={css.errorText}>
                    {result.error.code}: {result.error.message}
                  </p>
                )}
                <Section title={t('answers')}>
                  <Answers answers={result?.response?.answers ?? {}} request={check.request} t={t} />
                </Section>
                <details className={css.disclosure}>
                  <summary>{t('evidence')}</summary>
                  <pre>
                    {typeof check.request.state === 'string'
                      ? check.request.state
                      : JSON.stringify(check.request.state, null, 2)}
                  </pre>
                </details>
              </details>
            )
          })}
        </div>
      </Section>
      <Raw value={value} t={t} />
    </article>
  )
}
export function EvaluationDetail({
  value,
  busy,
  decide,
  t,
}: {
  value: EvaluationRecord
  busy: boolean
  decide: (action: 'accept' | 'reject') => void
  t: Translate
}) {
  return (
    <article className={css.detail}>
      <div className={css.row}>
        <span className={css.eyebrow}>{assessmentLabel(value.assessmentKind, t)}</span>
        <Badge value={value.status} t={t} />
      </div>
      <h2>{value.subject.title}</h2>
      <p className={css.muted}>
        {value.subject.kind === 'card' ? `${t('card')} ${value.subject.cardId}` : t('request')} ·{' '}
        {date(value.createdAt)}
      </p>
      <Section title={t('summary')}>
        <p className={css.conclusion}>{label(value.decision, t)}</p>
        <p>
          {t('confidence')} · <strong>{percent(value.confidence)}</strong>
        </p>
        <p className={css.muted}>{t('confidenceHint')}</p>
      </Section>
      {value.error !== undefined && (
        <div className={css.alert} data-tone="danger">
          <strong>{t('unavailable')}</strong>
          <p>{t('unavailableHint')}</p>
          <details>
            <summary>{t('errorDetail')}</summary>
            <pre>
              {value.error.code}: {value.error.message}
            </pre>
          </details>
        </div>
      )}
      <Section title={t('reasons')}>
        {value.reasons.length === 0 ? (
          <p>{t('noReasons')}</p>
        ) : (
          <ul>
            {value.reasons.map((reason, index) => (
              <li key={index}>{reasonText(reason, t)}</li>
            ))}
          </ul>
        )}
      </Section>
      {value.missingInformation.length > 0 && (
        <Section title={t('missing')}>
          <ul>
            {value.missingInformation.map((reason, index) => (
              <li key={index}>{reasonText(reason, t)}</li>
            ))}
          </ul>
        </Section>
      )}
      {value.createdCardId !== undefined && (
        <div className={css.callout}>
          {t('createdCard')} · {value.createdCardId}
        </div>
      )}
      {value.status === 'review' && value.decision === 'propose' && (
        <Section title={t('proposal')}>
          <h4>{value.proposedTitle ?? value.subject.title}</h4>
          <p className={css.prose}>
            {value.proposedBody ?? (value.subject.kind === 'request' ? value.subject.body : '')}
          </p>
          <div className={css.actions}>
            <button
              className={css.primary}
              disabled={busy}
              onClick={() => {
                decide('accept')
              }}
            >
              {t('accept')}
            </button>
            <button
              className={css.button}
              disabled={busy}
              onClick={() => {
                decide('reject')
              }}
            >
              {t('reject')}
            </button>
          </div>
        </Section>
      )}
      <Section title={t('answers')}>
        <Answers answers={value.answers} t={t} />
      </Section>
      <Section title={t('evidence')}>
        {value.evidence === undefined ? (
          <p className={css.muted}>{value.subject.kind === 'request' ? value.subject.body : t('noEvidence')}</p>
        ) : (
          <>
            <p className={css.prose}>{value.evidence.card.body}</p>
            {value.evidence.gaps.length > 0 && (
              <div className={css.alert}>
                <strong>{t('gaps')}</strong>
                <ul>
                  {value.evidence.gaps.map((gap, index) => (
                    <li key={index}>
                      {gap.path}: {gap.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <h4>
              {t('artifacts')} · {value.evidence.artifacts.length}
            </h4>
            {value.evidence.artifacts.map(artifact => (
              <details className={css.disclosure} key={artifact.path}>
                <summary>{artifact.path}</summary>
                <pre>{artifact.excerpt}</pre>
              </details>
            ))}
          </>
        )}
      </Section>
      <Raw value={value} t={t} />
    </article>
  )
}
