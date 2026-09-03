/**
 * Vocabulary types of the artifact-contract gate: the per-kind structure spec,
 * the read-only `devflowArtifactSpecs` value, and the dynamic
 * `devflowArtifactContract` inspection seam. Runtime code lives in the package
 * root.
 * @module @zhchxiao123/dsh-devflow-artifact-gate/types
 */

import type {} from '@deepseek-ai/cordis'

export type {
  ArtifactContract,
  ArtifactRequirementInspection,
  ArtifactRequirementStatus,
  ArtifactTransitionInspection,
  PublishedArtifactKindSpec,
} from '@zhchxiao123/dsh-devflow'

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
  /**
   * Section titles that must be present AND carry content — at least one
   * non-blank line before the next heading. Listing a title here implies its
   * presence, so it need not also appear in {@link sections}.
   *
   * Separate from `sections` rather than a stricter reading of it: changing
   * that list's meaning would silently tighten every kind already configured
   * against it. A heading whose section is empty satisfies a structure check
   * while answering nothing, which is the failure this catches; whether the
   * content is any *good* stays a judgement, and judgements belong to an
   * admission gate.
   */
  nonEmptySections?: string[]
}

/**
 * Value of the `devflowArtifactSpecs` service: the configured specs, deep
 * frozen and normalized (empty lists dropped).
 */
export type ArtifactSpecs = { readonly [kind: string]: ArtifactKindSpec }
