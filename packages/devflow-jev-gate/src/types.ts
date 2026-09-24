/**
 * Configuration vocabulary for the judgement gate. `Config` arrives from a
 * composition file, so `config.ts` validates every field before `apply` reads
 * it; nothing here carries runtime values.
 * @module @zhchxiao123/dsh-devflow-jev-gate/types
 */

import type { AssessmentKind } from '@zhchxiao123/dsh-devflow-jev'

/**
 * What a configured edge does with its judgements: a `warn` edge records them
 * in the transition journal and always lets the move proceed; an `enforce`
 * edge additionally vetoes when one of its configured {@link VetoConditions}
 * holds.
 */
export type EdgeMode = 'warn' | 'enforce'

/**
 * The closed set of conditions an `enforce` edge may veto on. Each condition
 * reads one answer of the stage rubric; the set stays deliberately small
 * because every entry is a grant of veto power that calibration data has to
 * justify per deployment.
 */
export interface VetoConditions {
  /**
   * Veto when the `releaseDecision` answer places at least this much
   * probability mass on `blocked` plus `unavailable` — a "ready" top choice
   * with heavy blocked mass is a wavering judgement, not a green light.
   * Requires the edge to run the `release-readiness` assessment.
   */
  readonly releaseBlockedMass?: number
  /**
   * Veto when the `changeRisk` score reaches this level **and** the answer's
   * confidence reaches {@link VetoConditions.riskConfidence}. A high score the
   * model is unsure about never vetoes; it lands as a recorded warning.
   * Requires the edge to run the `implementation-risk` assessment.
   */
  readonly riskScore?: number
  /** Confidence floor for {@link VetoConditions.riskScore}; defaults to 0. */
  readonly riskConfidence?: number
}

/** One configured edge of the transition waterfall. */
export interface EdgePolicy {
  /** The guarded move as `from->to`, e.g. `developing->reviewing`. */
  readonly edge: string
  /** Which stage assessments to run on this edge. */
  readonly kinds: readonly AssessmentKind[]
  readonly mode: EdgeMode
  /** Judgement deadline per assessment; a late judgement counts as unavailable. */
  readonly timeoutMs: number
  /**
   * `enforce` only: whether an unavailable judgement vetoes the move. A warn
   * edge always passes through, so the field is rejected there rather than
   * silently ignored.
   */
  readonly failClosed?: boolean
  /** `enforce` only: the conditions that veto. */
  readonly veto?: VetoConditions
}

/** Plugin configuration: the guarded edges. */
export interface Config {
  readonly edges: readonly EdgePolicy[]
}
