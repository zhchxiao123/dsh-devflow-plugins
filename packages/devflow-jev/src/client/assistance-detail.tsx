import type { AssistanceRecord } from '../assistance-types.ts'
import type { Translate } from './locales.ts'
import { Badge, Raw, Section } from './review-parts.tsx'
import { date, label } from './presentation.ts'
import css from './panel.module.css'

export function AssistanceDetail({ value, t }: { value: AssistanceRecord; t: Translate }) {
  return (
    <article className={css.detail}>
      <div className={css.row}><span className={css.eyebrow}>{t('assistance')}</span><Badge value={value.status} t={t} /></div>
      <h2>{value.card?.title ?? t('sessionScope')}</h2>
      <p className={css.scope}>{t('assistanceHint')}</p>
      <Section title={t('suggestedAction')}>
        <p className={css.conclusion}>{label(value.action, t)}</p>
        <p className={css.prose}>{value.reason}</p>
        <p className={css.muted}>{t('trigger')} · {label(value.event, t)} · {t('assistanceMode')} · {label(value.mode, t)}</p>
      </Section>
      <Section title={t('outcome')}>
        <Badge value={value.outcome} t={t} />
        {value.outcomeDetail !== undefined && <p>{value.outcomeDetail}</p>}
      </Section>
      <Section title={t('subject')}>
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
