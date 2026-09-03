/**
 * Anchor evaluation against the working tree.
 *
 * Every path here produces one of three verdicts, and `unevaluable` is never
 * collapsed into `fresh`: an anchor whose check can no longer run has not
 * passed, and reporting it as a pass is exactly how a permanently-green check
 * appears.
 * @module @zhchxiao123/dsh-devflow-spec-filesystem/src/anchor-eval
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnchorVerdict, ContentHashAnchor, SpecAnchor, SymbolAnchor } from '@zhchxiao123/dsh-devflow-spec'
import { findSymbolText, hashSymbol } from './normalize.ts'

/** Extensions the symbol parser understands; anything else is unevaluable, not fresh. */
const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/

/** What an evaluation needs beyond the anchor itself. */
export interface AnchorEvaluationContext {
  /** Absolute repository root the anchors' relative paths resolve against. */
  repoRoot: string
  /** The document's `updatedAt`; the comparison base for churn anchors. */
  updatedAt: string
  /**
   * Last-commit timestamp of one repository-relative file, or `undefined` when
   * the file is untracked. Omitted entirely when the deployment has no git, in
   * which case churn anchors report `unevaluable` rather than passing.
   */
  lastCommitAt?: (file: string) => Promise<string | undefined>
}

/**
 * Read one anchored source file.
 * @param repoRoot - absolute repository root.
 * @param file - repository-relative path.
 * @returns the contents, or `undefined` when the file no longer exists.
 * @throws when the path exists but cannot be read — an infrastructure failure,
 *   not a verdict about the anchor.
 */
async function readSource(repoRoot: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(repoRoot, file), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Evaluate a churn anchor: the watched file must not have been committed after
 * the document was last written.
 * @param anchor - the churn anchor.
 * @param context - the evaluation context.
 * @returns the verdict.
 */
async function evaluateChurn(anchor: SpecAnchor & { kind: 'churn' }, context: AnchorEvaluationContext): Promise<AnchorVerdict> {
  if (context.lastCommitAt === undefined) {
    return { id: anchor.id, status: 'unevaluable', reason: `no git history available for ${anchor.file}` }
  }
  const committedAt = await context.lastCommitAt(anchor.file)
  if (committedAt === undefined) {
    return { id: anchor.id, status: 'unevaluable', reason: `${anchor.file} is not tracked by git` }
  }
  if (Date.parse(committedAt) > Date.parse(context.updatedAt)) {
    return { id: anchor.id, status: 'stale', reason: `${anchor.file} was committed at ${committedAt}, after this document was written at ${context.updatedAt}` }
  }
  return { id: anchor.id, status: 'fresh' }
}

/**
 * Evaluate a symbol or content-hash anchor against the file's current text.
 * @param anchor - the symbolic anchor.
 * @param context - the evaluation context.
 * @returns the verdict.
 */
async function evaluateSymbolic(anchor: SymbolAnchor | ContentHashAnchor, context: AnchorEvaluationContext): Promise<AnchorVerdict> {
  if (!PARSEABLE.test(anchor.file)) {
    return { id: anchor.id, status: 'unevaluable', reason: `${anchor.file} is not a file the symbol parser reads; only a churn anchor can watch it` }
  }
  const source = await readSource(context.repoRoot, anchor.file)
  if (source === undefined) {
    return { id: anchor.id, status: 'stale', reason: `${anchor.file} no longer exists` }
  }
  if (anchor.kind === 'symbol') {
    return findSymbolText(source, anchor.symbol) === undefined
      ? { id: anchor.id, status: 'stale', reason: `${anchor.file} no longer declares ${anchor.symbol}` }
      : { id: anchor.id, status: 'fresh' }
  }
  const current = hashSymbol(source, anchor.symbol)
  if (current === undefined) {
    return { id: anchor.id, status: 'stale', reason: `${anchor.file} no longer declares ${anchor.symbol}` }
  }
  return current === anchor.hash
    ? { id: anchor.id, status: 'fresh' }
    : { id: anchor.id, status: 'stale', reason: `${anchor.symbol} in ${anchor.file} changed; recorded ${anchor.hash}, now ${current}` }
}

/**
 * Evaluate one anchor.
 * @param anchor - the anchor to evaluate.
 * @param context - the evaluation context.
 * @returns the verdict, one of `fresh` / `stale` / `unevaluable`.
 */
export async function evaluateAnchor(anchor: SpecAnchor, context: AnchorEvaluationContext): Promise<AnchorVerdict> {
  return anchor.kind === 'churn' ? evaluateChurn(anchor, context) : evaluateSymbolic(anchor, context)
}

/**
 * Evaluate every anchor of one document, in declaration order.
 * @param anchors - the document's declared anchors.
 * @param context - the evaluation context.
 * @returns one verdict per anchor.
 */
export async function evaluateAnchors(anchors: readonly SpecAnchor[], context: AnchorEvaluationContext): Promise<AnchorVerdict[]> {
  return Promise.all(anchors.map(anchor => evaluateAnchor(anchor, context)))
}
