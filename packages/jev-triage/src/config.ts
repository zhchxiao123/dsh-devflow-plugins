/**
 * Deployment-varying choices for diff triage: the rubric a file is scored
 * against, the line below which a file may be skipped, and the budgets one
 * batched call stays inside.
 * @module @zhchxiao123/dsh-jev-triage/config
 */

import z from '@deepseek-ai/schemastery'

/** How risk is described to the model. */
export const DEFAULT_SCORE_INSTRUCTION =
  'How risky is this change to the file? Risk means the chance the change hides a defect worth '
  + 'expert review: correctness bugs, security holes, broken contracts, data loss.'

/**
 * The rubric. Each level describes a concrete situation and stands on its own,
 * because the answer is a position among these descriptions and nothing else.
 * The number of levels is also the score ceiling, so adding or removing one
 * moves the ceiling with it.
 */
export const DEFAULT_SCORE_LEVELS: string[] = [
  'Trivial: comments, formatting, renames, docs, or strings with no logic.',
  'Routine: isolated logic with obvious behavior; no new interfaces; failures stay local.',
  'Notable: new or changed interfaces, cross-module reach, subtle state or async ordering.',
  'Risky: authentication, authorization, secrets, payments, concurrency, migrations, or error-prone parsing.',
  'Critical: destructive or irreversible operations, or a security-critical path that could fail silently.',
]

/** Files per batched call; the rest are reviewed without being scored. */
export const DEFAULT_MAX_FILES = 40
/** Characters of one file's diff that reach the model. */
export const DEFAULT_MAX_FILE_CHARS = 6000
/** Characters of diff across one call. */
export const DEFAULT_MAX_TOTAL_CHARS = 28_000
/** Below this score a file may be skipped. */
export const DEFAULT_SKIP_BELOW = 2
/** Below this confidence nothing is skipped, whatever it scored. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.4
/** Bytes of `git diff` output collected; a truncated capture is a fault. */
export const DEFAULT_STDOUT_MAX_BYTES = 4 * 1024 * 1024
/** Deadline for the whole tool call. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Triage configuration. */
export interface Config {
  /** Files per batched call; the rest are reviewed without being scored. */
  readonly maxFiles?: number
  /** Characters of one file's diff that reach the model; the rest is truncated. */
  readonly maxFileChars?: number
  /** Characters of diff across one call; questions past it are not asked. */
  readonly maxTotalChars?: number
  /** How risk is described to the model. */
  readonly scoreInstruction?: string
  /** The rubric; its length is the score ceiling. At least two levels. */
  readonly scoreLevels?: string[]
  /** Below this score a file may be skipped. `0` never skips anything. */
  readonly skipBelow?: number
  /** Below this confidence nothing is skipped, whatever it scored. */
  readonly confidenceFloor?: number
  /** Bytes of `git diff` output collected; a truncated capture is a fault. */
  readonly stdoutMaxBytes?: number
  /** Deadline for the whole tool call, in milliseconds. */
  readonly timeoutMs?: number
}

/** The config with every default applied. */
export type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  maxFiles: z.number().step(1).min(1).default(DEFAULT_MAX_FILES),
  maxFileChars: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_CHARS),
  maxTotalChars: z.number().step(1).min(1).default(DEFAULT_MAX_TOTAL_CHARS),
  scoreInstruction: z.string().default(DEFAULT_SCORE_INSTRUCTION),
  scoreLevels: z.array(z.string()).default([...DEFAULT_SCORE_LEVELS]),
  skipBelow: z.number().min(0).default(DEFAULT_SKIP_BELOW),
  confidenceFloor: z.number().min(0).max(1).default(DEFAULT_CONFIDENCE_FLOOR),
  stdoutMaxBytes: z.number().step(1).min(1).default(DEFAULT_STDOUT_MAX_BYTES),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
})

/**
 * Check what the schema cannot. Schemastery object properties are optional by
 * default and the schema admits `{}` and `null`, so the schema is a type filter
 * and this is the validation. The parameter is `unknown` for the same reason:
 * declaring it as {@link Config} would make each guard look unreachable.
 *
 * @param raw - the configuration as the composition supplied it.
 * @throws Error naming the offending config path.
 */
export function assertConfig(raw: unknown): asserts raw is ResolvedConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('jev-triage: config must be an object')
  }
  const config = raw as Record<string, unknown>
  const levels = config.scoreLevels
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new Error('jev-triage: config.scoreLevels must hold at least two levels; one level has nothing to discriminate')
  }
  if (levels.some(level => typeof level !== 'string' || level.length === 0)) {
    throw new Error('jev-triage: every config.scoreLevels entry must be a non-empty description')
  }
  const instruction = config.scoreInstruction
  if (typeof instruction !== 'string' || instruction.length === 0) {
    throw new Error('jev-triage: config.scoreInstruction must be a non-empty instruction')
  }
  const skipBelow = config.skipBelow
  if (typeof skipBelow !== 'number' || !Number.isFinite(skipBelow) || skipBelow < 0 || skipBelow > levels.length) {
    throw new Error(`jev-triage: config.skipBelow must be between 0 and ${String(levels.length)}, the rubric's ceiling`)
  }
  const floor = config.confidenceFloor
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new Error('jev-triage: config.confidenceFloor must be between 0 and 1')
  }
  for (const key of ['maxFiles', 'maxFileChars', 'maxTotalChars', 'stdoutMaxBytes', 'timeoutMs'] as const) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`jev-triage: config.${key} must be a positive whole number`)
    }
  }
}
