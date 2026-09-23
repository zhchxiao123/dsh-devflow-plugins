import type { AssistanceRecord } from '../assistance-types.ts'
import type { Translate } from './locales.ts'
import { Badge, Raw, Section } from './review-parts.tsx'
import { assistanceAction, assistanceAssociationReason, assistanceExplanation, assistanceDecisionReason, assistanceDiagnostic, assistanceOutcome, assistanceStaleReason, assistanceTitle, date, label } from './presentation.ts'
import css from './panel.module.css'

export function AssistanceDetail({ value, t }: { value: AssistanceRecord; t: Translate }) {
  return (
    <article className={css.detail}>
      <div className={css.row}><span className={css.eyebrow}>{t('assistance')}</span><Badge value={value.status} t={t} /></div>
      <h2>{assistanceTitle(value, t)}</h2>
      <p className={css.scope}>{t('assistanceHint')}</p>
      <Section title={t(assistanceDiagnostic(value) ? 'summary' : 'suggestedAction')}>
        <p className={css.conclusion}>{assistanceAction(value, t)}</p>
        <p className={css.prose}>{assistanceExplanation(value, t)}</p>
        <p className={css.muted}>{t('trigger')} · {label(value.event, t)} · {t('assistanceMode')} · {label(value.mode, t)}</p>
      </Section>
      {value.decisionReason !== undefined && <Section title={t('decisionReason')}><p>{assistanceDecisionReason(value.decisionReason, t)}</p></Section>}
      {value.rawAction !== undefined && <Section title={t('rawAction')}><p>{value.rawAction === 'continue' ? t('noIntervention') : label(value.rawAction, t)}</p></Section>}
      {value.staleReasons !== undefined && value.staleReasons.length > 0 && <Section title={t('staleReasons')}>
        <ul>{[...new Set(value.staleReasons)].map(reason => <li key={reason}>{assistanceStaleReason(reason, t)}</li>)}</ul>
      </Section>}
      <Section title={t('outcome')}>
        <p>{assistanceOutcome(value, t)}</p>
        {value.outcomeDetail !== undefined && <p>{value.outcomeDetail}</p>}
      </Section>
      <Section title={t('subject')}>
        {value.associationReason !== undefined && <p>{t('associationReason')} · {assistanceAssociationReason(value.associationReason, t)}</p>}
        <p>{value.card === undefined ? t('sessionScope') : `${t('card')} ${value.card.id} · ${t('revision')} ${value.card.revision} · ${value.card.stage}`}</p>
        <p>{t('session')} · {value.sessionId} · {t('turn')} {value.turn}</p>
        <p>{t('workspace')} · {value.workspace}</p>
      </Section>
      <Section title={t('gaps')}>
        {value.gaps.length === 0 ? <p className={css.muted}>{t('noGaps')}</p> : <ul>{[...new Set(value.gaps)].map(gap => <li key={gap}>{gap}</li>)}</ul>}
      </Section>
      <Section title={t('evidenceRefs')}>
        {value.evidenceRefs.length === 0 ? <p className={css.muted}>{t('noEvidence')}</p> : <ul>{[...new Set(value.evidenceRefs)].map(ref => <li key={ref}>{ref}</li>)}</ul>}
      </Section>
      <p className={css.muted}>{t('elapsed')} · {value.elapsedMs} ms</p>
      <p className={css.muted}>{t('createdAt')} · {date(value.createdAt)} · {t('updatedAt')} · {date(value.updatedAt)}</p>
      <Raw value={value} t={t} />
    </article>
  )
}
