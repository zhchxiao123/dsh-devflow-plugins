/* oxlint-disable @stylistic/max-len */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DevCard, DevflowJournalEntry } from '@zhchxiao123/dsh-devflow'
import type { CardEvidence, EvidenceArtifact, EvidenceGap, EvidenceRelation } from './types.ts'

const ARTIFACT_BYTES = 16 * 1024
const TOTAL_BYTES = 64 * 1024
const BODY_BYTES = 32 * 1024
const JOURNAL_BYTES = 128 * 1024
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function bounded(text: string, bytes: number): string { const value = Buffer.from(text); return value.byteLength <= bytes ? text : value.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '') }
function relation(card: DevCard): EvidenceRelation { return { id: card.id, title: bounded(card.title, 1024), stage: card.stage, stageRevision: card.stageRevision } }
function safeRelative(path: string): boolean { return path !== '' && !isAbsolute(path) && !path.split(/[\\/]/).some(part => part === '..' || part === '') }
async function containsSymlink(root: string, path: string): Promise<boolean> {
  let current = root
  for (const part of path.split(/[\\/]/)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) return true }
  return false
}
async function artifact(cardRoot: string, path: string, kind: string | undefined, remaining: number): Promise<{ artifact?: EvidenceArtifact; gap?: EvidenceGap; consumed: number }> {
  if (!safeRelative(path)) return { gap: { kind: 'unsafe', path, detail: 'Artifact path is not a safe relative path.' }, consumed: 0 }
  if (path.split(/[\\/]/).some(part => part.startsWith('.') || /^(?:credentials|secrets?|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i.test(part) || /\.(?:key|pem|p12|pfx)$/i.test(part))) return { gap: { kind: 'unsafe', path, detail: 'Credential-bearing or hidden files are not audit evidence.' }, consumed: 0 }
  const target = resolve(cardRoot, path)
  try {
    const root = await realpath(cardRoot); const actual = await realpath(target)
    const inside = relative(root, actual)
    if (inside.startsWith('..') || isAbsolute(inside) || await containsSymlink(cardRoot, path)) return { gap: { kind: 'unsafe', path, detail: 'Artifact resolves outside its card or through a symbolic link.' }, consumed: 0 }
    const info = await stat(actual)
    if (!info.isFile()) return { gap: { kind: 'unreadable', path, detail: 'Artifact is not a regular file.' }, consumed: 0 }
    const cap = Math.min(ARTIFACT_BYTES, remaining)
    if (cap <= 0) return { gap: { kind: 'oversized', path, detail: 'The audit evidence budget is exhausted.' }, consumed: 0 }
    if (info.size > cap) return { gap: { kind: 'oversized', path, detail: `Artifact is ${info.size} bytes; the remaining per-run budget is ${cap}.` }, consumed: 0 }
    const content = await readFile(actual, 'utf8')
    return { artifact: { path, ...(kind === undefined ? {} : { kind }), digest: digest(content), excerpt: content, truncated: false }, consumed: info.size }
  } catch (error: unknown) {
    // All operations in this block are Node filesystem calls, whose failures are ErrnoException values.
    const failure = error as NodeJS.ErrnoException
    return { gap: { kind: failure.code === 'ENOENT' ? 'missing' : 'unreadable', path, detail: failure.message }, consumed: 0 }
  }
}
export async function collectEvidence(root: string, card: DevCard, board: readonly DevCard[], entries: readonly DevflowJournalEntry[]): Promise<CardEvidence> {
  const cardRoot = join(root, 'tasks', card.id); const artifacts: EvidenceArtifact[] = []; const gaps: EvidenceGap[] = []; let consumed = 0
  for (const record of card.artifactRecords) {
    const result = await artifact(cardRoot, record.path, record.kind, TOTAL_BYTES - consumed)
    if (result.artifact !== undefined) artifacts.push(result.artifact)
    if (result.gap !== undefined) gaps.push(result.gap)
    consumed += result.consumed
  }
  const body = bounded(card.body, BODY_BYTES)
  if (Buffer.byteLength(card.body) > BODY_BYTES) gaps.push({ kind: 'oversized', path: 'card.md', detail: `Card body exceeds the ${BODY_BYTES}-byte evidence budget and was truncated.` })
  const journal: DevflowJournalEntry[] = []; let journalBytes = 2
  for (const entry of entries) { const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1; if (journalBytes + bytes > JOURNAL_BYTES) { gaps.push({ kind: 'oversized', path: 'journal.jsonl', detail: `Journal exceeds the ${JOURNAL_BYTES}-byte evidence budget; ${entries.length - journal.length} oldest or trailing entries were omitted.` }); break } journal.push(entry); journalBytes += bytes }
  const parent = card.parent === undefined ? undefined : board.find(candidate => candidate.id === card.parent)
  return {
    card: { id: card.id, title: bounded(card.title, 1024), body, stage: card.stage, stageRevision: card.stageRevision, serviceClass: card.serviceClass, ...(card.parent === undefined ? {} : { parent: card.parent }) },
    journal, artifacts, gaps,
    relations: { ...(parent === undefined ? {} : { parent: relation(parent) }), children: board.filter(candidate => candidate.parent === card.id).map(relation) },
  }
}
export function evidenceDigest(evidence: CardEvidence): string { return digest(JSON.stringify(evidence)) }
