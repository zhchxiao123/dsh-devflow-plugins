/**
 * The board's surface-neutral views: the grouped card list and one card's
 * read-only detail sheet, plus the row, timeline, and relation pieces they are
 * built from. Both take plain values — no slot-synthesized props, no store
 * handles — so the floating header control and the sidebar page render the
 * same views from whatever each surface has in hand.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, MarkdownText, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArtifactRecord, CardLocation, ClaimHolder, DevActor, DevCard, DevflowCardId, DevflowJournalEntry, DevStage, ServiceClass } from '@zhchxiao123/dsh-devflow/client'
import { groupByParent, isActive } from './board.ts'
import type { DevflowBoardRow } from './board.ts'
import { NS } from './locales.ts'
import css from './board.module.css'
/**
 * Mirrored from `DEV_STAGES` in `@zhchxiao123/dsh-devflow`: the client bundle
 * purity gate forbids cross-plugin value imports, so the closed pipeline order
 * is restated here. `satisfies` rejects a non-stage member, and the component
 * suite pins the segment count, so drift fails loudly.
 */
export const STAGE_ORDER = ['draft', 'designing', 'ready', 'developing', 'reviewing', 'testing', 'done'] as const satisfies readonly DevStage[]

/**
 * Mirrored from `DEFAULT_SERVICE_CLASS` in `@zhchxiao123/dsh-devflow` for the
 * same reason as {@link STAGE_ORDER}. Only a card that skips stages is marked:
 * an ordinary card would otherwise spend a badge saying it is ordinary.
 */
const DEFAULT_SERVICE_CLASS = 'standard' satisfies ServiceClass

/** The badge for a card that takes a shortened pipeline; `standard` shows none. */
function ServiceClassMark({ card, t }: { card: DevCard; t: TranslateNS<typeof NS> }): ReactNode {
  if (card.serviceClass === DEFAULT_SERVICE_CLASS) return null
  return <span className={css.serviceClass}>{t(`class.${card.serviceClass}`)}</span>
}

/** Status marker semantics per location; pre-active stages carry no dot. */
function dotState(stage: CardLocation): StateDotState | undefined {
  switch (stage) {
    case 'developing':
    case 'reviewing':
    case 'testing':
      return 'ongoing'
    case 'blocked':
      return 'warning'
    case 'done':
      return 'done'
    case 'draft':
    case 'designing':
    case 'ready':
      return undefined
  }
}

/** Localized stage word for a row and its accessible name. */
function stageLabel(stage: CardLocation, t: TranslateNS<typeof NS>): string {
  return t(`stage.${stage}`)
}

/**
 * Segment fill of one card's stage progress bar: how many pipeline stages the
 * card has reached and the tone of the reached run. A blocked card shows its
 * interrupted stage in the warning tone.
 * @param card - the rendered card.
 * @returns filled segment count (1-based) and the run's tone.
 */
function stageProgress(card: DevCard): { fill: number; tone: StateDotState } {
  const index = STAGE_ORDER.indexOf(card.stage as (typeof STAGE_ORDER)[number])
  if (index >= 0) return { fill: index + 1, tone: card.stage === 'done' ? 'done' : 'ongoing' }
  const from = card.blockedFrom === undefined ? -1 : STAGE_ORDER.indexOf(card.blockedFrom)
  return { fill: from + 1, tone: 'warning' }
}

/** `Date.parse` that reports unparseable timestamps as `undefined` instead of NaN. */
function parseAt(at: string): number | undefined {
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? undefined : ms
}

/** Coarse human duration: minutes under 90, hours under two days, days beyond. */
function formatDuration(ms: number, t: TranslateNS<typeof NS>): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 90) return t('duration.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('duration.hours', { n: hours })
  return t('duration.days', { n: Math.round(hours / 24) })
}

/** Localized label of one journal actor; an agent actor is its session id. */
function actorLabel(actor: DevActor, t: TranslateNS<typeof NS>): string {
  switch (actor.kind) {
    case 'human':
      return actor.name === undefined ? t('actor.human') : t('actor.human.named', { name: actor.name })
    case 'agent':
      return actor.session ?? t('actor.agent.unknown')
    case 'command':
      return actor.name === undefined ? t('actor.command') : t('actor.command.named', { name: actor.name })
  }
}

/**
 * Rework predicate mirrored from `isReworkEdge` in `@zhchxiao123/dsh-devflow`
 * (the client bundle purity gate forbids the value import): a move back to the
 * stage owning the fault — `designing` from `developing` or either checking
 * stage, `developing` from either checking stage.
 */
function isRework(entry: DevflowJournalEntry): boolean {
  if (entry.type !== 'transition') return false
  if (entry.to === 'designing') return entry.from === 'developing' || entry.from === 'reviewing' || entry.from === 'testing'
  return entry.to === 'developing' && (entry.from === 'reviewing' || entry.from === 'testing')
}

/** A timeline actor: a clickable session backlink while the session is known, plain text otherwise. */
function TimelineActor({ actor, openable, openSession, t }: {
  actor: DevActor
  openable: readonly string[]
  openSession: (id: string) => void
  t: TranslateNS<typeof NS>
}) {
  if (actor.kind === 'agent' && actor.session !== undefined && openable.includes(actor.session)) {
    const session = actor.session
    return (
      <button
        type="button"
        className={css.sessionLink}
        aria-label={t('timeline.openSession', { session })}
        onClick={() => { openSession(session) }}
      >
        {session}
      </button>
    )
  }
  return <span className={css.timelineActor}>{actorLabel(actor, t)}</span>
}

/** The headline of one timeline entry, by its journal kind. */
function entryLabel(entry: DevflowJournalEntry, t: TranslateNS<typeof NS>): string {
  switch (entry.type) {
    case 'created':
      return t('timeline.created')
    case 'transition':
      return t('timeline.move', { from: stageLabel(entry.from, t), to: stageLabel(entry.to, t) })
    case 'artifact':
      return t('timeline.artifact', { path: entry.path })
    case 'abandoned':
      return t('timeline.abandoned', { reason: entry.reason })
    case 'claim-expired':
      return t('timeline.takeover', { owner: actorLabel(entry.previousOwner, t) })
  }
}

/**
 * The card's transition timeline, newest entry first: headline, actor
 * (session backlinks while known), rework reason, approval signature, and the
 * duration spent since the previous entry — omitted whenever a hand-written
 * timestamp does not parse.
 */
function CardTimeline({ entries, openable, openSession, t }: {
  entries: readonly DevflowJournalEntry[]
  openable: readonly string[]
  openSession: (id: string) => void
  t: TranslateNS<typeof NS>
}) {
  return (
    <ul className={css.timeline} aria-label={t('detail.timeline')}>
      {entries.map((entry, index) => {
        const at = parseAt(entry.at)
        // A transition ends a stay in `entry.from`, which began at the nearest
        // earlier stage boundary (created or transition) — artifact and claim
        // entries mid-stage do not fragment the dwell.
        const boundary = entry.type === 'transition'
          ? entries.slice(0, index).findLast(candidate => candidate.type === 'created' || candidate.type === 'transition')
          : undefined
        const entered = boundary === undefined ? undefined : parseAt(boundary.at)
        const stayed = at !== undefined && entered !== undefined && at > entered ? at - entered : undefined
        const actor = entry.by
        return (
          <li key={entry.rev} className={css.timelineEntry}>
            <div className={css.timelineHead}>
              <span className={css.timelineLabel}>{entryLabel(entry, t)}</span>
              {actor === undefined ? null : <TimelineActor actor={actor} openable={openable} openSession={openSession} t={t} />}
            </div>
            <div className={css.timelineMeta}>
              <span className={css.revision}>{t('row.revision', { revision: entry.rev })}</span>
              {at === undefined ? null : <span>{new Date(at).toLocaleString()}</span>}
              {stayed === undefined ? null : <span>{t('timeline.stayed', { duration: formatDuration(stayed, t) })}</span>}
            </div>
            {entry.type === 'transition' && entry.reason !== undefined
              ? <div className={css.timelineNote}>{t('timeline.reason', { reason: entry.reason })}</div>
              : null}
            {entry.type === 'transition' && entry.gate?.approvedBy !== undefined
              ? <div className={css.timelineNote}>{t('timeline.approved', { owner: actorLabel(entry.gate.approvedBy, t) })}</div>
              : null}
            {/* Recorded gate verdicts ride beside the human approval — one
              gated move can carry both — and a cached verdict's `[cached] `
              summary prefix travels verbatim. */}
            {entry.type === 'transition'
              ? (entry.gate?.checks ?? []).map((check, position) => (
                <div key={position} className={css.timelineNote}>
                  {check.summary === undefined
                    ? t('timeline.check', { actor: actorLabel(check.by, t) })
                    : t('timeline.check.summary', { actor: actorLabel(check.by, t), summary: check.summary })}
                </div>
              ))
              : null}
          </li>
        )
      }).reverse()}
    </ul>
  )
}

/**
 * The timeline section's header line: the current lease holder with its
 * heartbeat freshness, plus the client-derived summary (card age from the
 * first entry, rework count). Every metric quietly disappears when its
 * timestamps do not parse.
 */
function TimelineSummary({ entries, holder, t }: {
  entries: readonly DevflowJournalEntry[]
  holder: ClaimHolder | undefined
  t: TranslateNS<typeof NS>
}) {
  const now = Date.now()
  const first = entries.at(0)
  const created = first === undefined ? undefined : parseAt(first.at)
  const beat = holder === undefined ? undefined : parseAt(holder.heartbeatAt)
  const reworks = entries.filter(isRework).length
  return (
    <div className={css.timelineSummary}>
      {holder === undefined ? null : (
        <span>
          {t('detail.holder', { owner: actorLabel(holder.owner, t) })}
          {beat === undefined || beat > now ? '' : ` · ${t('time.ago', { duration: formatDuration(now - beat, t) })}`}
        </span>
      )}
      {created === undefined || created > now ? null : <span>{t('detail.age', { duration: formatDuration(now - created, t) })}</span>}
      <span>{t('detail.reworks', { count: reworks })}</span>
    </div>
  )
}

/**
 * The detail view's breakdown section: the parent backlink of a child card and
 * the child list of a parent, each a control that drills to that card's
 * detail. Both sides come from the board listing the panel already holds, so
 * neither costs a fetch; a parent that left the active set reads as its bare
 * id. A card with no relation renders nothing.
 */
function CardRelations({ card, cards, openCardDetail, collapsible, t }: {
  card: DevCard
  cards: readonly DevCard[]
  openCardDetail: (id: DevflowCardId) => void
  collapsible: boolean
  t: TranslateNS<typeof NS>
}) {
  const parent = cards.find(candidate => candidate.id === card.parent)
  const children = cards.filter(candidate => candidate.parent === card.id)
  if (card.parent === undefined && children.length === 0) return null
  const blocks = (
    <>
      {card.parent === undefined ? null : (
        <div>
          <span className={css.detailSectionTitle}>{t('detail.parent')}</span>
          {parent === undefined
            ? <span className={css.detailEmpty}>{card.parent}</span>
            : (
              <button
                type="button"
                className={css.relationLink}
                aria-label={t('row.open', { id: parent.id })}
                onClick={() => { openCardDetail(parent.id) }}
              >
                <span className={css.id}>{parent.id}</span>
                {' '}
                {parent.title}
              </button>
            )}
        </div>
      )}
      {children.length === 0 ? null : (
        <div>
          <span className={css.detailSectionTitle}>
            {t('detail.children', { done: children.filter(child => !isActive(child)).length, total: children.length })}
          </span>
          <ul className={css.relationList}>
            {children.map(child => (
              <li key={child.id}>
                <button
                  type="button"
                  className={css.relationLink}
                  aria-label={t('row.open', { id: child.id })}
                  onClick={() => { openCardDetail(child.id) }}
                >
                  <span className={css.id}>{child.id}</span>
                  {' '}
                  {child.title}
                  {' '}
                  <span className={css.stage}>{stageLabel(child.stage, t)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
  // The floating panel has no room for another heading; the sidebar page's
  // foldable section needs one.
  return (
    <DetailSection
      title={collapsible ? t('detail.breakdown') : undefined}
      collapsible={collapsible}
      className={css.detailRelations}
    >
      {blocks}
    </DetailSection>
  )
}

/** One artifact line: its path, the registration facts when delivered, and the latest-of-kind marker. */
interface ArtifactRow {
  /** Artifact path relative to the card directory. */
  path: string
  /** The registration behind the path; `undefined` when the payload carried only the path projection. */
  record: ArtifactRecord | undefined
  /** Whether this is the newest of several registrations of one kind. */
  latest: boolean
}

/**
 * Artifact lines of one card. `artifacts` is the path projection of
 * `artifactRecords` — same order, entry for entry — so each line's
 * registration facts sit at the line's own index. Registrations are immutable
 * and every version stays listed; among several registrations of one kind the
 * highest revision is that kind's current content and carries the latest
 * marker. A kind registered once needs no distinguishing, and a path-only
 * registration supersedes nothing.
 */
function artifactRows(card: DevCard): ArtifactRow[] {
  // Like the blocked card whose journal lost its origin stage, the view
  // renders whatever one fetch delivered: a payload without the records still
  // lists its bare paths.
  const records = card.artifactRecords as readonly ArtifactRecord[] | undefined
  const kinds = new Map<string, { count: number; newest: number }>()
  for (const record of records ?? []) {
    if (record.kind === undefined) continue
    const tally = kinds.get(record.kind) ?? { count: 0, newest: 0 }
    kinds.set(record.kind, { count: tally.count + 1, newest: Math.max(tally.newest, record.rev) })
  }
  return card.artifacts.map((path, index) => {
    const record = records?.[index]
    const tally = record?.kind === undefined ? undefined : kinds.get(record.kind)
    return { path, record, latest: tally !== undefined && tally.count > 1 && record?.rev === tally.newest }
  })
}

/**
 * The detail sheet's artifact section body, read-only like the rest of the
 * sheet: one line per registration with its kind (a neutral placeholder for a
 * registration predating kinds), registering stage, and revision. Superseded
 * versions stay listed — the journal is a truthful history of every
 * deliverable — with the marker distinguishing the current one.
 */
function ArtifactList({ card, t }: { card: DevCard; t: TranslateNS<typeof NS> }) {
  if (card.artifacts.length === 0) return <span className={css.detailEmpty}>{t('detail.artifacts.none')}</span>
  return (
    <ul className={css.artifactList}>
      {artifactRows(card).map(row => (
        <li key={row.record === undefined ? row.path : row.record.rev} className={css.artifactRow}>
          <span className={css.artifactPath}>{row.path}</span>
          {row.record === undefined ? null : (
            <span className={css.artifactMeta}>
              {row.record.kind === undefined
                ? <span className={css.artifactKindNone}>{t('detail.artifact.kind.none')}</span>
                : <span className={css.artifactKind}>{row.record.kind}</span>}
              <span className={css.stage}>{stageLabel(row.record.stage, t)}</span>
              <span className={css.revision}>{t('row.revision', { revision: row.record.rev })}</span>
              {row.latest ? <span className={css.artifactLatest}>{t('detail.artifact.latest')}</span> : null}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Everything one card's detail sheet renders from; every surface supplies the same values. */
export interface CardDetailProps {
  /** The card being shown. */
  card: DevCard
  /** The whole listing, so the breakdown relations resolve without a fetch. */
  cards: readonly DevCard[]
  /** Decoded journal entries, oldest first; `undefined` before the detail loaded. */
  entries: readonly DevflowJournalEntry[] | undefined
  /** Current lease holder; `undefined` while unclaimed or unloaded. */
  holder: ClaimHolder | undefined
  /** Timeline agent sessions the client can switch to; others render as plain text. */
  openable: readonly string[]
  /** Drill to another card's detail (a breakdown relation). */
  openCardDetail: (id: DevflowCardId) => void
  /** Switch the app to a timeline backlink's session. */
  openSession: (id: string) => void
  /**
   * Render the sheet's four blocks as sections the reader can fold away. The
   * floating panel is too small for the affordance to pay for itself; the
   * sidebar page has the height to use it.
   */
  collapsible?: boolean
  /** Namespace translator. */
  t: TranslateNS<typeof NS>
}

/**
 * One block of the detail sheet: a bare titled region, or a foldable section
 * where the surface asked for one.
 */
function DetailSection({ title, collapsible, className, children }: {
  /** Heading of the block; omitted renders the body alone (the flat sheet's requirement block). */
  title: string | undefined
  collapsible: boolean
  /** CSS module class of the block; module members are typed as possibly absent. */
  className: string | undefined
  children: ReactNode
}) {
  if (!collapsible) {
    return (
      <div className={className}>
        {title === undefined ? null : <span className={css.detailSectionTitle}>{title}</span>}
        {children}
      </div>
    )
  }
  return (
    <details className={className} open>
      <summary className={css.detailSectionSummary}>{title}</summary>
      {children}
    </details>
  )
}

/**
 * The detail view's requirement sheet: identity, the enlarged named pipeline,
 * the Markdown body (its checklist read-only), the breakdown relations, the
 * artifact list, the timeline, and the card file path.
 * @param props - the card, the listing it belongs to, its journal and holder, and the drill intents.
 * @returns the read-only requirement sheet.
 */
export function CardDetail(
  { card, cards, entries, holder, openable, openCardDetail, openSession, collapsible = false, t }: CardDetailProps,
) {
  const progress = stageProgress(card)
  // A blocked card leads with why it stopped: the reason of the latest move
  // into `blocked`, when the journal recorded one.
  const blockedReason = card.stage !== 'blocked' || entries === undefined
    ? undefined
    : entries.findLast(
      (entry): entry is Extract<DevflowJournalEntry, { type: 'transition' }> =>
        entry.type === 'transition' && entry.to === 'blocked' && entry.reason !== undefined,
    )?.reason
  return (
    <div className={css.detail}>
      <div className={css.detailTitle}>{card.title}</div>
      <div className={css.detailMeta}>
        <span className={css.id}>{card.id}</span>
        <span className={css.stage} data-tone={progress.tone}>
          {stageLabel(card.stage, t)}
          {card.blockedFrom === undefined ? '' : ` (${t('row.blockedFrom', { stage: stageLabel(card.blockedFrom, t) })})`}
        </span>
        <ServiceClassMark card={card} t={t} />
        <span className={css.revision}>{t('row.revision', { revision: card.stageRevision })}</span>
      </div>
      {blockedReason === undefined ? null : (
        <div className={css.blockedReason}>{t('detail.blockedReason', { reason: blockedReason })}</div>
      )}
      <ol className={css.pipeline} aria-hidden>
        {STAGE_ORDER.map((stage, index) => (
          <li
            key={stage}
            className={css.pipelineStage}
            data-tone={index < progress.fill ? progress.tone : undefined}
            data-current={index === progress.fill - 1 ? true : undefined}
          >
            {stageLabel(stage, t)}
          </li>
        ))}
      </ol>
      {card.body.length === 0 ? null : (
        <DetailSection
          title={collapsible ? t('detail.requirement') : undefined}
          collapsible={collapsible}
          className={collapsible ? css.detailRequirement : css.detailBody}
        >
          {collapsible ? <div className={css.detailBody}><MarkdownText text={card.body} /></div> : <MarkdownText text={card.body} />}
        </DetailSection>
      )}
      <CardRelations card={card} cards={cards} openCardDetail={openCardDetail} collapsible={collapsible} t={t} />
      <DetailSection title={t('detail.artifacts')} collapsible={collapsible} className={css.detailArtifacts}>
        <ArtifactList card={card} t={t} />
      </DetailSection>
      {entries === undefined ? null : (
        <DetailSection title={t('detail.timeline')} collapsible={collapsible} className={css.detailTimeline}>
          <TimelineSummary entries={entries} holder={holder} t={t} />
          <CardTimeline entries={entries} openable={openable} openSession={openSession} t={t} />
        </DetailSection>
      )}
      <div className={css.detailPath}>{card.path}</div>
    </div>
  )
}

/** One board line: the opener button carrying a card's state, with an optional breakdown summary. */
function BoardCardRow({ card, summary, openCardDetail, t }: {
  card: DevCard
  summary: ReactNode
  openCardDetail: (id: DevflowCardId) => void
  t: TranslateNS<typeof NS>
}) {
  const dot = dotState(card.stage)
  const progress = stageProgress(card)
  return (
    <button
      type="button"
      className={css.rowButton}
      aria-label={t('row.open', { id: card.id })}
      onClick={() => { openCardDetail(card.id) }}
    >
      <div className={css.rowMain}>
        {dot === undefined ? null : <StateDot state={dot} className={css.rowDot} />}
        <span className={css.id}>{card.id}</span>
        <span className={css.title} title={card.title}>{card.title}</span>
        <span className={css.stage} data-tone={progress.tone}>
          {stageLabel(card.stage, t)}
          {card.blockedFrom === undefined ? '' : ` (${t('row.blockedFrom', { stage: stageLabel(card.blockedFrom, t) })})`}
        </span>
        <ServiceClassMark card={card} t={t} />
      </div>
      <div className={css.rowMeta}>
        <span className={css.progress} aria-hidden>
          {STAGE_ORDER.map((stage, index) => (
            <i
              key={stage}
              className={css.segment}
              data-tone={index < progress.fill ? progress.tone : undefined}
              data-current={index === progress.fill - 1 ? true : undefined}
            />
          ))}
        </span>
        {summary}
        <span className={css.revision}>{t('row.revision', { revision: card.stageRevision })}</span>
      </div>
    </button>
  )
}

/**
 * One top-level board row plus, while expanded, the sub-requirements it
 * decomposes into. The parent line carries the `k/n` breakdown progress and a
 * marker when a child is blocked; the toggle sits outside the opener so the
 * row keeps exactly one control per card plus one collapse control.
 */
function BoardGroupRows({ row, collapsed, toggle, openCardDetail, t }: {
  row: DevflowBoardRow
  collapsed: boolean
  toggle: (id: DevflowCardId) => void
  openCardDetail: (id: DevflowCardId) => void
  t: TranslateNS<typeof NS>
}) {
  const rowClass = (card: DevCard, nested: boolean): string =>
    `${css.row}${isActive(card) ? '' : ` ${css.rowSettled}`}${nested ? ` ${css.rowNested}` : ''}`
  return (
    <>
      <li className={rowClass(row.card, false)}>
        <div className={css.rowGroup}>
          {row.children.length === 0 ? null : (
            <button
              type="button"
              className={css.rowToggle}
              aria-expanded={!collapsed}
              aria-label={t(collapsed ? 'row.children.expand' : 'row.children.collapse', { id: row.card.id })}
              onClick={() => { toggle(row.card.id) }}
            >
              <IconChevronDownOutline14 className={collapsed ? css.rowToggleCollapsed : undefined} />
            </button>
          )}
          <BoardCardRow
            card={row.card}
            summary={row.childTotal === 0
              ? null
              : (
                <span className={css.childSummary} data-blocked={row.blockedChildren ? true : undefined}>
                  {t('row.children', { done: row.doneChildren, total: row.childTotal })}
                  {row.blockedChildren ? ` · ${t('row.children.blocked')}` : ''}
                </span>
              )}
            openCardDetail={openCardDetail}
            t={t}
          />
        </div>
      </li>
      {collapsed
        ? null
        : row.children.map(child => (
          <li key={child.id} className={rowClass(child, true)}>
            <BoardCardRow card={child} summary={null} openCardDetail={openCardDetail} t={t} />
          </li>
        ))}
    </>
  )
}

/** Everything the grouped card list renders from; every surface supplies the same values. */
export interface BoardListProps {
  /** The listing to render, grouped into one level of nesting here. */
  cards: readonly DevCard[]
  /**
   * Show only cards at this location; omitted shows every card. A requirement
   * whose own location misses stays as the context of a matching child.
   */
  stage?: CardLocation
  /** Open one card's detail. */
  openCardDetail: (id: DevflowCardId) => void
  /** Namespace translator. */
  t: TranslateNS<typeof NS>
}

/**
 * Narrow grouped rows to one location, keeping a matching child's requirement
 * as its context.
 * @param rows - the grouped rows.
 * @param stage - the location to keep; omitted keeps everything.
 * @returns the rows to render.
 */
function atStage(rows: readonly DevflowBoardRow[], stage: CardLocation | undefined): DevflowBoardRow[] {
  if (stage === undefined) return [...rows]
  return rows.flatMap((row) => {
    const children = row.children.filter(child => child.stage === stage)
    if (row.card.stage !== stage && children.length === 0) return []
    return [{ ...row, children }]
  })
}

/**
 * The board's card list: every top-level card in reading order with the
 * sub-requirements it decomposes into indented beneath it, each parent row
 * carrying its `k/n` breakdown progress and a collapse control.
 * @param props - the listing, an optional stage filter, the detail intent, and the translator.
 * @returns the list element; an empty listing renders an empty list.
 */
export function BoardList({ cards, stage, openCardDetail, t }: BoardListProps) {
  const rows = useMemo(() => atStage(groupByParent(cards), stage), [cards, stage])
  // Collapse is a view preference of the rendered list, so it lives here and
  // resets with a remount rather than travelling through the store.
  const [collapsed, setCollapsed] = useState<ReadonlySet<DevflowCardId>>(new Set())
  const toggle = (id: DevflowCardId): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  return (
    <ul className={css.list} aria-label={t('board.aria')}>
      {rows.map(row => (
        <BoardGroupRows
          key={row.card.id}
          row={row}
          collapsed={collapsed.has(row.card.id)}
          toggle={toggle}
          openCardDetail={openCardDetail}
          t={t}
        />
      ))}
    </ul>
  )
}
