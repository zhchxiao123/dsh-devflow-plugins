/**
 * How the triage result reaches a model and a session log.
 *
 * Both functions here run on the live stream **and** again when a session log
 * is replayed, so neither touches a clock, a file, or a service — they project
 * the value they are handed and nothing else.
 * @module @zhchxiao123/dsh-jev-triage/present
 */

import type { FileVerdict, TriageResult } from './triage.ts'

/** Any value that survives a JSON round trip, as the tool surface requires. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** One block of model-facing text. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * Say what triage decided, in the terms a reviewer acts on.
 *
 * @param value - the triage result.
 * @returns one text block.
 */
export function render(value: TriageResult): TextBlock[] {
  if (!value.available) {
    return [{
      type: 'text',
      text: `jev_triage is unavailable: ${value.note ?? 'unknown reason'}\n`
        + 'Treat every changed file as needing review.',
    }]
  }
  const lines = [
    `jev_triage: ${String(value.files.length)} file(s) — `
    + `${String(value.review_count)} to review, ${String(value.skip_count)} skipped`,
  ]
  for (const file of value.files) lines.push(line(file))
  if (value.note !== undefined) lines.push(`Note: ${value.note}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * One file's line.
 *
 * @param file - the verdict.
 * @returns the rendered line.
 */
function line(file: FileVerdict): string {
  const parts = [file.action.toUpperCase(), file.path]
  if (file.score !== undefined) {
    parts.push(`score ${String(file.score)}${file.level === undefined ? '' : ` (${file.level})`}`)
  }
  if (file.confidence !== undefined) parts.push(`conf ${String(file.confidence)}`)
  if (file.reason !== undefined) parts.push(`[${file.reason}]`)
  return parts.join('  ')
}

/**
 * The replayable record of one triage.
 *
 * This is the audit trail for the whole capability: it lands on the session's
 * `tool/result` and survives a reload, which is why it carries structure rather
 * than the note's prose.
 *
 * @param value - the triage result.
 * @returns the record.
 */
export function presentationMeta(value: TriageResult): JsonValue {
  return {
    available: value.available,
    review: value.review_count,
    skip: value.skip_count,
    files: value.files.map(file => ({
      path: file.path,
      action: file.action,
      ...file.score === undefined ? {} : { score: file.score },
      ...file.confidence === undefined ? {} : { confidence: file.confidence },
    })),
  }
}
