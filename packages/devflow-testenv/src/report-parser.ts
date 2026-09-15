/**
 * Projection of a runner's machine-readable report onto {@link FailureEntry}
 * lines — this plugin's second durable/file boundary, and a pure one: the
 * caller owns reading the file, so every function here is a total transform of
 * text into failures plus diagnostics.
 *
 * Nothing throws. A report that cannot be read is a degraded failure list, not
 * a failed run: the phase verdict comes from the test command's exit code, and
 * letting a defective report override it would report the wrong thing.
 */

import type { FailureAttachment, FailureEntry, ParsedReport, ReportFormat } from './types.ts'

/**
 * Terminal styling emitted into report text. Playwright writes SGR sequences
 * into `error.message` and `error.stack` (never into `error.snippet`), and a
 * model reading them sees escape noise around the words that matter.
 */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

/** One parser per declared format; adding a format adds an entry, never a branch. */
const PARSERS: Record<ReportFormat, (text: string) => ParsedReport> = {
  'playwright-json': parsePlaywrightJson,
}

/**
 * Project one report's text onto the cases that failed.
 * @param text - the report file's contents.
 * @param format - the parser the manifest declared.
 * @returns the failures the report names, and every defect met while reading it.
 */
export function parseReport(text: string, format: ReportFormat): ParsedReport {
  return PARSERS[format](text)
}

/**
 * Playwright's `json` reporter: a `suites` forest whose leaves are specs, with
 * describe blocks nested as child suites. Top-level suites are the spec files,
 * so their titles stay out of the case address — `spec.file` already carries
 * the file.
 */
function parsePlaywrightJson(text: string): ParsedReport {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { failures: [], diagnostics: [`the report is not parseable JSON: ${message(error)}`] }
  }
  if (!isMapping(document) || !Array.isArray(document.suites)) {
    return { failures: [], diagnostics: ['the report is not a Playwright JSON report (no top-level suites list)'] }
  }
  const failures: FailureEntry[] = []
  for (const suite of document.suites) collectFailures(suite, [], failures)
  return { failures, diagnostics: [] }
}

/** Walk one suite and its children, appending every failed spec in report order. */
function collectFailures(suite: unknown, describePath: readonly string[], failures: FailureEntry[]): void {
  if (!isMapping(suite)) return
  if (Array.isArray(suite.specs)) {
    for (const spec of suite.specs) {
      const failure = failedSpec(spec, describePath)
      if (failure !== undefined) failures.push(failure)
    }
  }
  if (Array.isArray(suite.suites)) {
    for (const child of suite.suites) {
      collectFailures(child, [...describePath, isMapping(child) ? stringOr(child.title, '') : ''], failures)
    }
  }
}

/** One spec's failure entry, or `undefined` when the spec passed or is unreadable. */
function failedSpec(spec: unknown, describePath: readonly string[]): FailureEntry | undefined {
  if (!isMapping(spec) || spec.ok !== false) return undefined
  const title = [...describePath, stringOr(spec.title, '')].filter(part => part.length > 0).join(' › ')
  const error = lastError(spec.tests)
  const attachments = collectedAttachments(spec.tests)
  return {
    title,
    ...optional('file', stringOrUndefined(spec.file)),
    ...optional('line', numberOrUndefined(spec.line)),
    ...optional('column', numberOrUndefined(spec.column)),
    ...optional('message', stripped(error?.message)),
    ...optional('snippet', stripped(error?.snippet)),
    ...attachments.length === 0 ? {} : { attachments },
  }
}

/**
 * The error of the last attempt that carried one. Retries append results, and
 * the attempt that settled the case is the one worth reporting.
 */
function lastError(tests: unknown): { message?: unknown; snippet?: unknown } | undefined {
  let found: { message?: unknown; snippet?: unknown } | undefined
  for (const result of results(tests)) {
    if (isMapping(result.error)) found = result.error
  }
  return found
}

/** Every attachment of every attempt, in report order, that names a file on disk. */
function collectedAttachments(tests: unknown): FailureAttachment[] {
  const attachments: FailureAttachment[] = []
  for (const result of results(tests)) {
    if (!Array.isArray(result.attachments)) continue
    for (const entry of result.attachments) {
      if (!isMapping(entry)) continue
      const path = stringOrUndefined(entry.path)
      const contentType = stringOrUndefined(entry.contentType)
      if (path === undefined || contentType === undefined) continue
      attachments.push({ name: stringOr(entry.name, path), path, contentType })
    }
  }
  return attachments
}

/** Every result of every test of one spec, flattened in report order. */
function* results(tests: unknown): Generator<Record<string, unknown>> {
  if (!Array.isArray(tests)) return
  for (const test of tests) {
    if (!isMapping(test) || !Array.isArray(test.results)) continue
    for (const result of test.results) {
      if (isMapping(result)) yield result
    }
  }
}

/** The value without terminal styling; `undefined` for anything that is not text. */
function stripped(value: unknown): string | undefined {
  const text = stringOrUndefined(value)
  return text === undefined ? undefined : text.replace(ANSI, '')
}

/** A one-key object for a present value, so optional fields stay absent rather than undefined. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringOr(value: unknown, fallback: string): string {
  return stringOrUndefined(value) ?? fallback
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function message(error: unknown): string {
  /* v8 ignore next -- JSON.parse throws SyntaxError; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}
