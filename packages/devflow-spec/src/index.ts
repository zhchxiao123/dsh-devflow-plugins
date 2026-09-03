/**
 * Service Definition of the `ctx.devflowSpec` capability seam: architecture
 * documents whose claims are tied to the code they describe by evaluable
 * anchors. This package owns the anchor vocabulary and the structural
 * predicates every write must pass. Storage and anchor evaluation belong to a
 * provider such as `@zhchxiao123/dsh-devflow-spec-filesystem`; the model-facing
 * write tool belongs to `@zhchxiao123/dsh-devflow-spec-tool`.
 * @module @zhchxiao123/dsh-devflow-spec
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AnchorVerdict, SpecDocument, SpecSummary, SpecWriteRequest, SpecWriteResult, SpecWriteSpec } from './types.ts'

export type * from './types.ts'
export { ANCHOR_KINDS, SOURCE_OF_TRUTH_HEADING, checkAnchorCitations, citedAnchorIds, hasSourceOfTruth, isAnchorKind, isValidSpecId, worstFreshness } from './anchors.ts'
export type { AnchorDefect } from './anchors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    devflowSpec: DevflowSpecStore
  }
}

/**
 * Abstract architecture-document store registered as `ctx.devflowSpec` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior). Subclass, implement the abstract methods, and
 * load the subclass as a plugin.
 *
 * Optional service: consumers read it with `ctx.get('devflowSpec')`, never the
 * property proxy — a deployment without the seam simply has no documents.
 *
 * Implementations must honor these semantics:
 * - A document's claims are only as good as its anchors, so every read reports
 *   the anchors' verdicts alongside the body. A reader must be able to learn
 *   that what it just read is stale.
 * - `unevaluable` is reported as itself, never folded into `fresh`. A check
 *   that can no longer run is not a check that passed.
 * - The write path is the only way a document reaches disk; the documents live
 *   under a directory `@zhchxiao123/dsh-devflow-fs-guard` denies file tools,
 *   so this is enforced rather than merely intended.
 */
export abstract class DevflowSpecStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'devflowSpec')
  }

  /**
   * List the documents of one root as index values.
   * @param scope - optional id prefix narrowing to one package or face; omitted lists every document.
   * @param root - spec root to list; omitted uses the implementation's default root.
   * @returns summaries ordered by id, each carrying rolled-up freshness.
   */
  abstract list(scope?: string, root?: string): Promise<SpecSummary[]>

  /**
   * Read one document with its anchors evaluated.
   * @param id - the document id.
   * @param root - spec root holding the document; omitted uses the implementation's default root.
   * @returns the document, its declared anchors, and their verdicts.
   */
  abstract read(id: string, root?: string): Promise<SpecDocument>

  /**
   * Evaluate one document's anchors without reading its body.
   * @param id - the document id.
   * @param root - spec root holding the document; omitted uses the implementation's default root.
   * @returns one verdict per declared anchor, in declaration order.
   */
  abstract evaluate(id: string, root?: string): Promise<AnchorVerdict[]>

  /**
   * Apply implementation-owned defaults to a write request: the spec root when
   * omitted and the commit timestamp.
   * @param request - the caller's request.
   * @returns the fully specified spec to hand to {@link write}.
   */
  abstract resolveWrite(request: SpecWriteRequest): SpecWriteSpec

  /**
   * Commit one document: id check, structural checks, anchor resolution and
   * evaluation, then the file write. A content-hash anchor stated without a
   * `hash` takes the anchored symbol's current digest; every anchor must then
   * evaluate `fresh` — a document may not be born stale.
   * @param spec - a resolved spec from {@link resolveWrite}, never a raw request.
   * @returns the outcome; domain rejections resolve with `ok: false`, while
   *   infrastructure failures (unwritable root, unreadable source file) reject.
   */
  abstract write(spec: SpecWriteSpec): Promise<SpecWriteResult>
}

export default DevflowSpecStore
