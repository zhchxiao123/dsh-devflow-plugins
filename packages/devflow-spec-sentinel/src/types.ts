/**
 * Types shared by the sentinel's collection, turn-end, rendering, and
 * workspace-layout modules, plus the optional `devflowSpecWorkspace` service
 * another plugin reads with `ctx.get`.
 * @module @zhchxiao123/dsh-devflow-spec-sentinel/src/types
 */

import type {} from '@deepseek-ai/cordis'
import type { SpecAnchorKind, SpecFreshness } from '@zhchxiao123/dsh-devflow-spec'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional workspace-layout seam published by this plugin: the mechanical
     * answer to "which packages live in this workspace, under which scope
     * ids". Consumers read it with `ctx.get('devflowSpecWorkspace')`; a
     * deployment without the sentinel falls back to whatever scope
     * configuration it carries itself.
     */
    devflowSpecWorkspace: DevflowSpecWorkspace
  }
}

/** One workspace member: its directory and the scope id its documents live under. */
export interface WorkspacePackage {
  /** Absolute path of the package directory. */
  readonly dir: string
  /** The package's `package.json` name — the first segment(s) of its spec ids. */
  readonly scopeId: string
}

/** Value of the `devflowSpecWorkspace` service. */
export interface DevflowSpecWorkspace {
  /**
   * Resolve one workspace root's package layout.
   * @param root - absolute or cwd-relative workspace root.
   * @returns the member packages; empty (never a rejection) when the root
   *   carries no readable manifest — resolution failure is warned about, not
   *   thrown, because every consumer sits on a model-facing path.
   */
  layout(root: string): Promise<readonly WorkspacePackage[]>
}

/** The absolute file paths one agent's tool calls have touched. */
export interface TurnTouches {
  /**
   * Files landed by a successful `write`/`edit` since the last turn-end
   * evaluation; the sentinel clears this set when it settles a turn.
   */
  readonly written: Set<string>
  /**
   * Files a successful `read` returned; session-cumulative with a bounded
   * recency window. Nothing at turn end consumes it — it lights the pre-step
   * spec index's scope layer.
   */
  readonly read: Set<string>
  /**
   * Files ever landed by a successful `write`/`edit`, session-cumulative with
   * the same recency window. Kept apart from {@link written} so the sentinel's
   * turn-scoped clearing never blanks the spec index: a document deferred at
   * turn end stays visible there exactly because this set survives the turn.
   */
  readonly sessionWritten: Set<string>
}

/** One document the spec index lists because its anchors claim touched files. */
export interface AnchorHitEntry {
  readonly id: string
  readonly freshness: SpecFreshness
  /** Repository-relative anchored files the session's writes hit, deduplicated. */
  readonly files: readonly string[]
  /** Ids of the anchors currently judged stale; empty unless {@link freshness} is `stale`. */
  readonly failingAnchorIds: readonly string[]
}

/** One document the spec index lists because it lives under a touched package's scope. */
export interface ScopeDocEntry {
  readonly id: string
  readonly title: string
  readonly freshness: SpecFreshness
}

/** One anchor a turn's writes left stale, in the render's vocabulary. */
export interface StaleAnchor {
  /** Document-local anchor id, as its verdict names it. */
  readonly id: string
  readonly kind: SpecAnchorKind
  /** Repository-relative path of the anchored file. */
  readonly file: string
  /** Present for the symbol-bearing anchor kinds. */
  readonly symbol?: string
  /** The stale verdict's reason. */
  readonly reason: string
}

/** One document the sentinel interrupts over, with its failing anchors. */
export interface StaleDocument {
  readonly id: string
  readonly anchors: readonly StaleAnchor[]
}
