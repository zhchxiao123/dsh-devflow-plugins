/**
 * Read-only calibration export over `.devflow/judgements`: every persisted
 * judgement answer becomes one dataset row, joined with the human
 * accept/reject verdict its evaluation later received and the gate edges the
 * journal shows it was consulted on. The summary buckets acceptance by the
 * measure each answer type actually carries — distribution confidence for
 * Choice/Score, probability for Noul — because the two scales must never be
 * pooled.
 *
 * The tool writes a dataset and a summary and nothing else: no API call, no
 * configuration change. Threshold changes stay a human Config edit, and a
 * group below {@link MINIMUM_LABELED} labeled samples says so instead of
 * pretending its rates mean anything.
 *
 *   pnpm exec tsx scripts/jev-calibration.ts <devflow-root> --out <dir>
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Below this many labeled samples a group's rates are noise, not calibration. */
export const MINIMUM_LABELED = 100

export type Language = 'cjk' | 'latin' | 'mixed' | 'unknown'

export interface CalibrationRow {
  readonly source: 'evaluation' | 'assistance'
  readonly id: string
  readonly assessmentKind?: string
  readonly rubricVersion?: string
  readonly answerId: string
  readonly answerType: 'choice' | 'score' | 'noul'
  readonly value: string | number
  /** Distribution confidence for choice/score; probability of yes for noul. */
  readonly measure: number
  readonly language: Language
  readonly status?: string
  readonly decision?: string
  /** Human verdict, when one was recorded. */
  readonly label?: 'accepted' | 'rejected'
  readonly gateEdges?: readonly string[]
}

export interface CalibrationBucket { readonly range: string; readonly total: number; readonly labeled: number; readonly accepted: number }
export interface CalibrationGroup {
  readonly source: string
  readonly answerType: string
  readonly language: Language
  readonly total: number
  readonly labeled: number
  readonly buckets: readonly CalibrationBucket[]
  /** True when the group is too small to justify any threshold change. */
  readonly insufficientForThresholds: boolean
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/u
const LETTER = /[a-z぀-ヿ㐀-鿿豈-﫿]/giu

/** Classify evidence text by CJK share of its letters; the deterministic heuristic #34 asked for. */
export function languageOf(text: string): Language {
  const letters = text.match(LETTER) ?? []
  if (letters.length === 0) return 'unknown'
  const share = letters.filter(letter => CJK.test(letter)).length / letters.length
  return share >= 0.5 ? 'cjk' : share <= 0.05 ? 'latin' : 'mixed'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }

function answerRow(answerId: string, raw: unknown): Pick<CalibrationRow, 'answerId' | 'answerType' | 'value' | 'measure'> | undefined {
  const answer = record(raw)
  if (answer === undefined) return undefined
  if (answer.type === 'noul') {
    const probability = finite(answer.noul)
    return probability === undefined ? undefined : { answerId, answerType: 'noul', value: probability, measure: probability }
  }
  const confidence = finite(answer.confidence)
  if (confidence === undefined) return undefined
  if (answer.type === 'score') {
    const value = finite(answer.score)
    return value === undefined ? undefined : { answerId, answerType: 'score', value, measure: confidence }
  }
  if (answer.type === 'choice' && typeof answer.choice === 'string') {
    return { answerId, answerType: 'choice', value: answer.choice, measure: confidence }
  }
  return undefined
}

/** One row per readable answer; `undefined` for a file that is not an evaluation record. */
export function rowsFromEvaluation(value: unknown, gateEdges: ReadonlyMap<string, readonly string[]>): CalibrationRow[] | undefined {
  const evaluation = record(value)
  if (evaluation === undefined || typeof evaluation.id !== 'string' || record(evaluation.answers) === undefined) return undefined
  const subject = record(evaluation.subject) ?? {}
  const evidenceBody = text(record(record(evaluation.evidence)?.card)?.body)
  const language = languageOf([text(subject.title), text(evaluation.proposedTitle), text(evaluation.proposedBody), evidenceBody].join('\n'))
  const status = text(evaluation.status)
  const label = status === 'accepted' || status === 'created' ? 'accepted' as const : status === 'rejected' ? 'rejected' as const : undefined
  const edges = gateEdges.get(evaluation.id)
  return Object.entries(record(evaluation.answers) ?? {}).flatMap(([answerId, raw]) => {
    const base = answerRow(answerId, raw)
    if (base === undefined) return []
    return [{
      source: 'evaluation' as const, id: evaluation.id as string, ...base, language,
      ...text(evaluation.assessmentKind) === '' ? {} : { assessmentKind: text(evaluation.assessmentKind) },
      ...text(evaluation.rubricVersion) === '' ? {} : { rubricVersion: text(evaluation.rubricVersion) },
      ...status === '' ? {} : { status }, ...text(evaluation.decision) === '' ? {} : { decision: text(evaluation.decision) },
      ...label === undefined ? {} : { label }, ...edges === undefined ? {} : { gateEdges: edges },
    }]
  })
}

/** Assistance deliveries carry no human verdict; their rows feed volume and language statistics only. */
export function rowsFromAssistance(value: unknown): CalibrationRow[] | undefined {
  const assistance = record(value)
  if (assistance === undefined || typeof assistance.id !== 'string' || typeof assistance.action !== 'string') return undefined
  const measure = finite(assistance.actionConfidence)
  if (measure === undefined) return []
  return [{
    source: 'assistance', id: assistance.id, answerId: 'action', answerType: 'choice',
    value: assistance.action, measure, language: languageOf(text(assistance.reason)),
    ...text(assistance.policyVersion) === '' ? {} : { rubricVersion: text(assistance.policyVersion) },
  }]
}

/** Evaluation ids the judgement gate consulted, keyed to the `from->to` edges the journal records. */
export function gateEdgesFromJournal(journalText: string): Map<string, string[]> {
  const edges = new Map<string, string[]>()
  for (const line of journalText.split('\n')) {
    if (line.trim() === '') continue
    let entry: Record<string, unknown> | undefined
    try { entry = record(JSON.parse(line)) } catch { continue /* A torn journal line is not this tool's problem to repair. */ }
    if (entry?.type !== 'transition') continue
    const checks = record(entry.gate)?.checks
    if (!Array.isArray(checks)) continue
    for (const raw of checks) {
      const check = record(raw)
      if (text(record(check?.by)?.name) !== 'devflow-jev-gate') continue
      const id = /\[([0-9a-f-]+)\]/u.exec(text(check?.summary))?.[1]
      if (id === undefined) continue
      const edge = `${text(entry.from)}->${text(entry.to)}`
      edges.set(id, [...edges.get(id) ?? [], edge])
    }
  }
  return edges
}

const BUCKETS = [[0, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.000001]] as const

/** Acceptance per measure bucket, grouped by source × answer type × language. */
export function summarize(rows: readonly CalibrationRow[]): CalibrationGroup[] {
  const groups = new Map<string, CalibrationRow[]>()
  for (const row of rows) {
    const key = `${row.source}\0${row.answerType}\0${row.language}`
    groups.set(key, [...groups.get(key) ?? [], row])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => {
    const [source, answerType, language] = key.split('\0') as [string, string, Language]
    const labeled = members.filter(row => row.label !== undefined)
    return {
      source, answerType, language, total: members.length, labeled: labeled.length,
      buckets: BUCKETS.map(([low, high]) => {
        const inside = members.filter(row => row.measure >= low && row.measure < high)
        const insideLabeled = inside.filter(row => row.label !== undefined)
        return { range: `[${low}, ${high >= 1 ? '1' : String(high)})`, total: inside.length, labeled: insideLabeled.length, accepted: insideLabeled.filter(row => row.label === 'accepted').length }
      }),
      insufficientForThresholds: labeled.length < MINIMUM_LABELED,
    }
  })
}

/** Render the summary; every under-sampled group carries the warning inline. */
export function renderSummary(groups: readonly CalibrationGroup[], skipped: readonly string[]): string {
  const lines = ['# JEV calibration summary', '', 'Read-only export; thresholds change only by a human Config edit.', '']
  for (const group of groups) {
    lines.push(`## ${group.source} · ${group.answerType} · ${group.language}`, '', `- rows: ${String(group.total)}, labeled: ${String(group.labeled)}`)
    if (group.insufficientForThresholds) lines.push(`- **insufficient for thresholds**: fewer than ${String(MINIMUM_LABELED)} labeled samples — do not tune floors from this group`)
    for (const bucket of group.buckets) {
      if (bucket.total === 0) continue
      lines.push(`- measure ${bucket.range}: ${String(bucket.total)} rows, ${String(bucket.labeled)} labeled${bucket.labeled === 0 ? '' : `, accepted ${String(bucket.accepted)}/${String(bucket.labeled)}`}`)
    }
    lines.push('')
  }
  if (skipped.length > 0) lines.push(`Skipped ${String(skipped.length)} unreadable file(s): ${skipped.join(', ')}`, '')
  return lines.join('\n')
}

async function jsonFiles(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => name.endsWith('.json')).sort().map(name => join(directory, name)) } catch { return [] /* An absent judgements branch means zero rows, not a failure. */ }
}

export interface CalibrationExport { readonly rows: CalibrationRow[]; readonly groups: CalibrationGroup[]; readonly skipped: string[] }

/** Scan one devflow root and write `dataset.jsonl` plus `summary.md` under `outDir`. */
export async function exportCalibration(devflowRoot: string, outDir: string): Promise<CalibrationExport> {
  const skipped: string[] = []
  const edges = new Map<string, string[]>()
  let taskDirs: string[] = []
  try { taskDirs = (await readdir(join(devflowRoot, 'tasks'))).sort() } catch { /* A root without tasks still may hold request evaluations. */ }
  for (const task of taskDirs) {
    try {
      for (const [id, taskEdges] of gateEdgesFromJournal(await readFile(join(devflowRoot, 'tasks', task, 'journal.jsonl'), 'utf8'))) {
        edges.set(id, [...edges.get(id) ?? [], ...taskEdges])
      }
    } catch { skipped.push(`tasks/${task}/journal.jsonl`) }
  }
  const rows: CalibrationRow[] = []
  for (const [directory, read] of [
    [join(devflowRoot, 'judgements', 'evaluations'), (value: unknown) => rowsFromEvaluation(value, edges)],
    [join(devflowRoot, 'judgements', 'assistance'), rowsFromAssistance],
  ] as const) {
    for (const file of await jsonFiles(directory)) {
      let parsed: CalibrationRow[] | undefined
      try { parsed = read(JSON.parse(await readFile(file, 'utf8'))) } catch { parsed = undefined }
      if (parsed === undefined) skipped.push(file)
      else rows.push(...parsed)
    }
  }
  const groups = summarize(rows)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'dataset.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length === 0 ? '' : '\n'))
  await writeFile(join(outDir, 'summary.md'), renderSummary(groups, skipped))
  return { rows, groups, skipped }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const outFlag = argv.indexOf('--out')
  const out = outFlag >= 0 ? argv[outFlag + 1] : undefined
  const root = argv.filter((_argument, index) => index !== outFlag && index !== outFlag + 1)[0]
  if (root === undefined || out === undefined) {
    console.error('usage: tsx scripts/jev-calibration.ts <devflow-root> --out <dir>')
    process.exitCode = 2
    return
  }
  const result = await exportCalibration(root, out)
  console.log(renderSummary(result.groups, result.skipped))
  console.log(`${String(result.rows.length)} rows -> ${join(out, 'dataset.jsonl')}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
