import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AssessmentKind, AuditProfile, AuditSummary, EvaluationRecord, EvaluationSummary } from '../types.ts'
import type { AssistanceRecord } from '../assistance-types.ts'
import { AssistanceDetail } from './assistance-detail.tsx'
import type { JevRunSnapshot } from '@zhchxiao123/dsh-jev'
import { request } from './api.ts'
import type { Translate } from './locales.ts'
import { useRecords } from './use-records.ts'
import { Badge, ErrorNotice } from './review-parts.tsx'
import { AuditDetail, EvaluationDetail, GenericDetail } from './review-detail.tsx'
import { ReviewForm } from './review-form.tsx'
import { assessmentLabel, assistanceAction, assistanceDiagnostic, assistanceExplanation, assistanceModeHint, assistanceOutcome, assistanceTitle, date, label, providerError, reasonText, resumable } from './presentation.ts'
import css from './panel.module.css'
export interface Props {
  sessionId: string
  visible: boolean
  refreshMs: number
  t: Translate
}
type RecordItem =
  | { kind: 'assistance'; id: string; title: string; at: string; value: AssistanceRecord }
  | { kind: 'audits'; id: string; title: string; at: string; value: AuditSummary }
  | { kind: 'runs'; id: string; title: string; at: string; value: JevRunSnapshot }
  | { kind: 'judgements'; id: string; title: string; at: string; value: EvaluationSummary }
type Selection =
  | { kind: 'assistance'; value: AssistanceRecord }
  | { kind: 'audit'; value: AuditSummary }
  | { kind: 'run'; value: JevRunSnapshot }
  | { kind: 'evaluation'; value: EvaluationRecord }
class ReviewBoundary extends Component<{ t: Translate; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? (
      <div className={css.empty} role="alert">
        <p>{this.props.t('fatal')}</p>
        <button
          className={css.button}
          onClick={() => {
            this.setState({ failed: false })
          }}
        >
          {this.props.t('retry')}
        </button>
      </div>
    ) : (
      this.props.children
    )
  }
}
export function JudgementPanel(props: Props) {
  return (
    <ReviewBoundary key={props.sessionId} t={props.t}>
      {props.sessionId.trim() === '' ? (
        <p className={css.empty}>{props.t('noProject')}</p>
      ) : (
        <ProjectPanel {...props} />
      )}
    </ReviewBoundary>
  )
}
function ProjectPanel({ sessionId, visible, refreshMs, t }: Props) {
  const { data, errors, loading, refresh } = useRecords(sessionId, visible, refreshMs)
  const [filter, setFilter] = useState<'all' | RecordItem['kind']>('all')
  const [search, setSearch] = useState('')
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [selection, setSelection] = useState<Selection>()
  const [parent, setParent] = useState<Selection>()
  const [form, setForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const action = useRef<AbortController>()
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  useEffect(
    () => () => {
      action.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (content === null) return
    content.scrollTop = 0
    content.focus()
  }, [
    content,
    selection?.kind,
    selection?.kind === 'audit'
      ? selection.value.manifest.id
      : selection?.kind === 'run'
        ? selection.value.definition.id
        : selection?.value.id,
    form,
  ])
  const selectedEvaluationId = selection?.kind === 'evaluation' ? selection.value.id : undefined
  useEffect(() => {
    if (selectedEvaluationId === undefined || busy || !visible || document.visibilityState === 'hidden') return
    const controller = new AbortController()
    const hide = () => { if (document.visibilityState === 'hidden') controller.abort() }
    document.addEventListener('visibilitychange', hide)
    void request({ method: 'read', sessionId, id: selectedEvaluationId }, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return
        setSelection(previous =>
          previous?.kind === 'evaluation' && previous.value.id === value.id ? { kind: 'evaluation', value } : previous,
        )
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setActionError(String(error))
      },
    )
    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', hide)
    }
  }, [selectedEvaluationId, sessionId, data.evaluations, busy, visible])
  const perform = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (action.current !== undefined) return
    const controller = new AbortController()
    action.current = controller
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      await operation(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) setActionError(String(error))
    } finally {
      if (!controller.signal.aborted) {
        action.current = undefined
        setBusy(false)
      }
    }
  }
  const openEvaluation = (id: string, from?: Selection) =>
    void perform(async (signal) => {
      const value = await request({ method: 'read', sessionId, id }, signal)
      if (signal.aborted) return
      setParent(from)
      setSelection({ kind: 'evaluation', value })
      setForm(false)
    })
  const open = (item: RecordItem) => {
    setActionError('')
    setNotice('')
    setParent(undefined)
    if (item.kind === 'assistance') void perform(async (signal) => {
      const value = await request({ method: 'assistance-read', sessionId, id: item.id }, signal)
      if (!signal.aborted) setSelection({ kind: 'assistance', value })
    })
    else if (item.kind === 'judgements') openEvaluation(item.id)
    else
      setSelection(item.kind === 'audits' ? { kind: 'audit', value: item.value } : { kind: 'run', value: item.value })
  }
  const refreshedAssistance = selection?.kind === 'assistance'
    ? data.assistance?.find(item => item.id === selection.value.id)
    : undefined
  const current: Selection | undefined =
    selection?.kind === 'audit'
      ? {
        kind: 'audit',
        value: data.audits?.find(item => item.manifest.id === selection.value.manifest.id) ?? selection.value,
      }
      : selection?.kind === 'run'
        ? {
          kind: 'run',
          value: data.runs?.find(item => item.definition.id === selection.value.definition.id) ?? selection.value,
        }
        : selection?.kind === 'assistance'
          ? { kind: 'assistance', value: refreshedAssistance !== undefined && refreshedAssistance.updatedAt >= selection.value.updatedAt ? refreshedAssistance : selection.value }
          : selection
  const control = (selected: Extract<Selection, { kind: 'audit' | 'run' }>, mode: 'resume' | 'cancel') =>
    void perform(async (signal) => {
      const method =
        selected.kind === 'audit'
          ? mode === 'resume'
            ? 'audit-resume'
            : 'audit-cancel'
          : mode === 'resume'
            ? 'run-resume'
            : 'run-cancel'
      const runId = selected.kind === 'audit' ? selected.value.manifest.id : selected.value.definition.id
      const result = await request({ method, sessionId, runId }, signal)
      if (signal.aborted) return
      setNotice(t(result.outcome === 'requested' ? 'cancelledNotice' : 'saved'))
      await refresh()
    })
  const decide = (id: string, method: 'accept' | 'reject') =>
    void perform(async (signal) => {
      const value = await request({ method, sessionId, id }, signal)
      if (signal.aborted) return
      setSelection({ kind: 'evaluation', value })
      setNotice(t('saved'))
      await refresh()
    })
  const audit = (profile: AuditProfile, maxCards: number) =>
    void perform(async (signal) => {
      const value = await request({ method: 'audit-start', sessionId, profile, maxCards }, signal)
      if (signal.aborted) return
      setSelection({ kind: 'audit', value })
      setForm(false)
      await refresh()
    })
  const assess = (title: string, body: string) =>
    void perform(async (signal) => {
      const value = await request({ method: 'assess', sessionId, title, body }, signal)
      if (signal.aborted) return
      setSelection({ kind: 'evaluation', value })
      setForm(false)
      await refresh()
    })
  const generic = (title: string, evidence: string, questions: string[]) =>
    void perform(async (signal) => {
      const value = await request({ method: 'run-start', sessionId, title, evidence, questions }, signal)
      if (signal.aborted) return
      setSelection({ kind: 'run', value })
      setForm(false)
      await refresh()
    })
  const assessCard = (id: string, assessmentKind: AssessmentKind) =>
    void perform(async (signal) => {
      const value = await request({ method: 'assess-card', sessionId, id, assessmentKind }, signal)
      if (signal.aborted) return
      setSelection({ kind: 'evaluation', value })
      setForm(false)
      await refresh()
    })
  const renderDetail = (selected: Selection) => {
    if (selected.kind === 'audit') return <AuditDetail value={selected.value} busy={busy} t={t}
      control={(mode) => { control(selected, mode) }} openEvaluation={(id) => { openEvaluation(id, selected) }} />
    if (selected.kind === 'run') return <GenericDetail value={selected.value} busy={busy} t={t}
      control={(mode) => { control(selected, mode) }} />
    if (selected.kind === 'assistance') return <AssistanceDetail value={selected.value} t={t} />
    return <EvaluationDetail value={selected.value} busy={busy} t={t} decide={(method) => { decide(selected.value.id, method) }} />
  }
  const items: RecordItem[] = [
    ...(data.assistance ?? []).map(value => ({ kind: 'assistance' as const, id: value.id, title: assistanceTitle(value, t), at: value.createdAt, value })),
    ...(data.audits ?? []).map(value => ({
      kind: 'audits' as const,
      id: value.manifest.id,
      title: label(value.manifest.profile, t),
      at: value.manifest.createdAt,
      value,
    })),
    ...(data.runs ?? []).map(value => ({
      kind: 'runs' as const,
      id: value.definition.id,
      title: value.definition.scope.title,
      at: value.definition.createdAt,
      value,
    })),
    ...(data.evaluations ?? []).map(value => ({
      kind: 'judgements' as const,
      id: value.id,
      title: value.subject.title,
      at: value.createdAt,
      value,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const query = search.trim().toLocaleLowerCase()
  const matching = items.filter(
    item =>
      (filter === 'all' || item.kind === filter) && `${item.title} ${item.id} ${item.kind === 'assistance' ? `${item.value.card?.id ?? ''} ${item.value.sessionId} ${item.value.reason}` : ''}`.toLocaleLowerCase().includes(query),
  )
  // The default view answers one question: is there anything to act on? A
  // kind tab is an explicit request to inspect that kind, so it bypasses the
  // fold; everything non-actionable stays reachable behind the toggle.
  const diagnosticCount = filter === 'all' ? matching.filter(item => !actionable(item)).length : 0
  const filtered = matching.filter(item => filter !== 'all' || showDiagnostics || actionable(item))
  const loaded = data.audits !== undefined || data.evaluations !== undefined || data.runs !== undefined
  const back = () => {
    setForm(false)
    setSelection(parent)
    setParent(undefined)
    setActionError('')
    setNotice('')
  }
  return (
    <section className={css.page} aria-label={t('title')}>
      <header className={css.header}>
        <div className={css.row}>
          <h1>{t('title')}</h1>
          <div className={css.actions}>
            <button className={css.button} disabled={loading || busy} onClick={() => void refresh()}>
              {t('refresh')}
            </button>
            {current === undefined && !form && (
              <button
                className={css.primary}
                disabled={busy}
                onClick={() => {
                  setForm(true)
                  setNotice('')
                }}
              >
                {t('newReview')}
              </button>
            )}
          </div>
        </div>
        <div className={css.project}>
          <span>{t('workspace')}</span>
          <strong title={data.context?.projectPath}>
            {data.context?.projectName ?? (errors.length > 0 ? t('loadError') : t('loading'))}
          </strong>
        </div>
      </header>
      <div className={css.body} ref={setContent} tabIndex={-1}>
        <ErrorNotice errors={errors} stale={loaded} t={t} />
        <ErrorNotice errors={actionError === '' ? [] : [actionError]} t={t} />
        {notice !== '' && (
          <p className={css.notice} role="status">
            {notice}
          </p>
        )}
        {form ? (
          <>
            <button className={css.linkButton} disabled={busy} onClick={back}>← {t('back')}</button>
            <ReviewForm busy={busy} t={t} audit={audit} assess={assess} generic={generic} assessCard={assessCard}
              genericAvailable={data.context?.genericRunsAvailable === true} />
          </>
        ) : current !== undefined ? (
          <>
            <button className={css.linkButton} disabled={busy} onClick={back}>← {t('back')}</button>
            {renderDetail(current)}
          </>
        ) : (
          <>
            <nav className={css.filters} aria-label={t('coverage')}>
              {(['all', 'runs', 'audits', 'judgements', 'assistance'] as const).map(kind => (
                <button
                  key={kind}
                  className={css.filter}
                  aria-pressed={filter === kind}
                  onClick={() => {
                    setFilter(kind)
                  }}
                >
                  {t(kind)}{' '}
                  <span>{kind === 'all' ? items.length : items.filter(item => item.kind === kind).length}</span>
                </button>
              ))}
            </nav>
            <input
              className={css.search}
              type="search"
              aria-label={t('search')}
              placeholder={t('search')}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
            />
            {filter === 'assistance' && <p className={css.scope}>{data.context?.assistanceAvailable === true ? `${t('assistanceMode')} · ${assistanceModeHint(data.context.assistanceMode, t)}` : t('assistanceUnavailable')}</p>}
            {data.context?.genericRunsAvailable === false && <p className={css.scope}>{t('genericUnavailable')}</p>}
            {diagnosticCount > 0 && <div className={css.callout}>
              <button className={css.linkButton} aria-expanded={showDiagnostics} onClick={() => { setShowDiagnostics(value => !value) }}>
                {t(showDiagnostics ? 'hideDiagnostics' : 'showDiagnostics')} · {diagnosticCount}
              </button>
              <p className={css.muted}>{t('diagnosticsHint')}</p>
            </div>}
            {!loaded && errors.length > 0 ? null : !loaded ? (
              <p role="status" className={css.empty}>
                {t('loading')}
              </p>
            ) : filtered.length === 0 ? (
              <div className={css.empty}>
                <h2>{diagnosticCount > 0 ? t('allQuiet') : items.length === 0 ? t('empty') : t('noMatches')}</h2>
                {diagnosticCount === 0 && <p>{t('emptyHint')}</p>}
              </div>
            ) : (
              <div className={css.records}>
                {filtered.map(item => (
                  <RecordCard
                    key={`${item.kind}-${item.id}`}
                    item={item}
                    t={t}
                    busy={busy}
                    open={() => {
                      open(item)
                    }}
                    resume={
                      (item.kind === 'audits' || item.kind === 'runs') && resumable(item.value.state.status)
                        ? () => {
                          control(item.kind === 'audits' ? { kind: 'audit', value: item.value } : { kind: 'run', value: item.value }, 'resume')
                        }
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
/** Whether a record asks the user for anything: a proposal awaiting a verdict, a blocked audit, or actionable advice. */
function actionable(item: RecordItem): boolean {
  if (item.kind === 'assistance') return !assistanceDiagnostic(item.value)
  if (item.kind === 'judgements') return item.value.status === 'review' && item.value.subject.kind === 'request'
  if (item.kind === 'audits') return item.value.state.conclusion === 'blocked'
  return false
}
function RecordCard({ item, t, busy, open, resume }: {
  item: RecordItem
  t: Translate
  busy: boolean
  open: () => void
  resume: (() => void) | undefined
}) {
  const state = item.kind === 'judgements' || item.kind === 'assistance' ? undefined : item.value.state
  // A finished audit is read by its conclusion; the run status alone says only
  // that the call ended, which decides nothing.
  const conclusion = item.kind === 'audits' ? item.value.state.conclusion : undefined
  const status = item.kind === 'judgements'
    ? (item.value.status === 'review' ? item.value.decision : item.value.status)
    : item.kind === 'assistance' ? item.value.status : conclusion ?? item.value.state.status
  return (
    <div className={css.record}>
      <button className={css.recordBody} disabled={busy} onClick={open}>
        <span className={css.row}>
          <span className={css.eyebrow}>
            {item.kind === 'judgements' ? assessmentLabel(item.value.assessmentKind, t) : t(item.kind)}
          </span>
          <Badge value={status} t={t} />
        </span>
        <strong className={css.recordTitle}>{item.title}</strong>
        {state !== undefined ? (
          <>
            <span className={css.row}>
              <span className={css.muted}>
                {item.kind === 'audits' ? `${item.value.manifest.cardCount} ${t('cards')} · ` : ''}
                {t('processed')} {state.completed}/{state.total}
              </span>
              {state.failed > 0 && (
                <span className={css.errorText}>
                  {t('errors')} {state.failed}
                </span>
              )}
            </span>
            <progress aria-label={t('progress')} max={Math.max(1, state.total)} value={state.completed} />
            {state.status === 'interrupted' && <span className={css.muted}>{t('interruptedCardHint')}</span>}
          </>
        ) : (
          item.kind === 'judgements' && (
            item.value.status === 'unavailable' ? (
              <span className={css.errorText}>{providerError(item.value.error?.code, t)}</span>
            ) : (
              <span className={css.excerpt}>
                {item.value.reasons[0] === undefined ? t('noReasons') : reasonText(item.value.reasons[0], t)}
              </span>
            )
          )
        )}
        {item.kind === 'assistance' && <>
          <span className={css.excerpt}>{assistanceAction(item.value, t)} · {assistanceExplanation(item.value, t)}</span>
          <span className={css.muted}>{assistanceOutcome(item.value, t)} · {item.value.card?.id ?? t('sessionScope')} · {item.value.elapsedMs} ms</span>
        </>}
        <span className={css.row}>
          <time className={css.muted}>{date(item.at)}</time>
          <span className={css.detailLink}>{t('details')} →</span>
        </span>
      </button>
      {resume !== undefined && (
        <button className={css.button} disabled={busy} onClick={resume}>
          {t('resumeAudit')}
        </button>
      )}
    </div>
  )
}
