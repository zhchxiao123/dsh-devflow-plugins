/**
 * Collection of what a red test phase left on disk: the files the manifest's
 * `evidence` globs name, and the failed cases its `report` names. Both are
 * optional, and a manifest declaring neither collects nothing.
 *
 * A declaration that matches nothing is itself reported. That is the whole
 * reason the globs live in the manifest rather than in prose: a path that rots
 * — an output directory renamed, a reporter switched off — surfaces on the
 * next red run instead of quietly yielding a failure report with no evidence
 * in it.
 *
 * Collection never throws. The phase verdict belongs to the test command's
 * exit code, so an unreadable report or an unstattable file degrades the
 * evidence and leaves the verdict alone.
 */

import { glob, readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { parseReport } from './report-parser.ts'
import type { EvidenceFile, EvidenceReport, FailureEntry, TestenvManifest } from './types.ts'

/**
 * Extensions the harness's attachment service can normalize into a viewable
 * image. Anything else is carried as a path, so this map decides only what is
 * worth offering inline, never what is reported.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Collect one failed run's evidence.
 * @param manifest - the validated manifest, whose `evidence` and `report` drive the collection.
 * @param root - absolute workspace root that both resolve against.
 * @returns the evidence, or `undefined` when the manifest declares neither field.
 */
export async function collectEvidence(
  manifest: TestenvManifest,
  root: string,
): Promise<EvidenceReport | undefined> {
  if (manifest.evidence === undefined && manifest.report === undefined) return undefined
  const diagnostics: string[] = []
  const failures = await readFailures(manifest, root, diagnostics)
  const files = await collectFiles(manifest, root, failures, diagnostics)
  return { files, failures, diagnostics }
}

/** The report's failed cases, or an empty list with the reason it could not be read. */
async function readFailures(
  manifest: TestenvManifest,
  root: string,
  diagnostics: string[],
): Promise<readonly FailureEntry[]> {
  const spec = manifest.report
  if (spec === undefined) return []
  let text: string
  try {
    text = await readFile(resolve(root, spec.path), 'utf8')
  } catch (error) {
    diagnostics.push(
      `the declared ${spec.format} report at ${spec.path} could not be read (${message(error)});`
      + ' the verdict below still comes from the test command\'s exit code',
    )
    return []
  }
  const parsed = parseReport(text, spec.format)
  diagnostics.push(...parsed.diagnostics.map(issue => `${spec.path}: ${issue}`))
  return parsed.failures
}

/** Every evidence file known from either source, deduplicated by path and ordered by it. */
async function collectFiles(
  manifest: TestenvManifest,
  root: string,
  failures: readonly FailureEntry[],
  diagnostics: string[],
): Promise<readonly EvidenceFile[]> {
  const byPath = new Map<string, string | undefined>()
  for (const failure of failures) {
    for (const attachment of failure.attachments ?? []) {
      byPath.set(resolve(root, attachment.path), attachment.contentType)
    }
  }
  const matched = await matchedPaths(manifest.evidence, root, diagnostics)
  for (const path of matched) {
    if (!byPath.has(path)) byPath.set(path, IMAGE_TYPES[extname(path).toLowerCase()])
  }
  if (manifest.evidence !== undefined && matched.length === 0) {
    diagnostics.push(
      `the declared evidence (${manifest.evidence.join(', ')}) matched no files after this failed run;`
      + ' either the run wrote none, or the declaration no longer names where it writes them',
    )
  }
  const files: EvidenceFile[] = []
  for (const [path, contentType] of [...byPath].sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = await sizeOf(path)
    if (bytes === undefined) continue
    files.push({ name: basename(path), path, bytes, ...contentType === undefined ? {} : { contentType } })
  }
  return files
}

/** Absolute paths of every regular file the globs name, in glob then filesystem order. */
async function matchedPaths(
  globs: readonly string[] | undefined,
  root: string,
  diagnostics: string[],
): Promise<readonly string[]> {
  if (globs === undefined) return []
  const paths: string[] = []
  for (const pattern of globs) {
    try {
      for await (const match of glob(pattern, { cwd: root })) paths.push(resolve(root, match))
    } catch (error) {
      /* v8 ignore next 2 -- Node's glob yields nothing rather than throwing for every input
         this code can reach it with (patterns are contained at manifest load, the cwd is the
         session's own root); the guard is here for a traversal-level filesystem failure. */
      diagnostics.push(`the evidence glob ${pattern} could not be expanded (${message(error)})`)
    }
  }
  return paths
}

/** The file's size, or `undefined` for anything that is not a readable regular file. */
async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path)
    return stats.isFile() ? stats.size : undefined
  } catch {
    // Swallows the stat error for a path that vanished between the glob and
    // this call; a file that is gone is simply not evidence, and nothing else
    // in the report depends on it.
    return undefined
  }
}

function message(error: unknown): string {
  /* v8 ignore next -- fs rejections are Error instances; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}
