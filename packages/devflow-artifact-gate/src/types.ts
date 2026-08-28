/**
 * Vocabulary types of the artifact-contract gate: the per-kind structure spec
 * and the read-only `devflowArtifactSpecs` service shape. Runtime code lives in
 * the package root.
 * @module @zhchxiao123/dsh-devflow-artifact-gate/types
 */

import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The gate's configured kind specs, published read-only so a producer can
     * shape a deliverable to the same spec the gate will check. Optional
     * service: read it with `ctx.get('devflowArtifactSpecs')`.
     */
    devflowArtifactSpecs: ArtifactSpecs
  }
}

/**
 * Structural requirements of one artifact kind. Both lists are optional and an
 * empty list equals omission; a kind declared with neither is required only to
 * be registered. The lists stay mutable in type for the config validator's
 * sake; the published service value is deep frozen regardless.
 */
export interface ArtifactKindSpec {
  /**
   * Frontmatter fields the artifact must carry, each present with a value —
   * a key mapped to nothing counts as missing.
   */
  frontmatter?: string[]
  /** Second-level section titles (without the `## ` prefix) the artifact must contain. */
  sections?: string[]
}

/**
 * Value of the `devflowArtifactSpecs` service: the configured specs, deep
 * frozen and normalized (empty lists dropped).
 */
export type ArtifactSpecs = { readonly [kind: string]: ArtifactKindSpec }
