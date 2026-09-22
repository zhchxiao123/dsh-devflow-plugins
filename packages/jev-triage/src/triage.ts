/**
 * Turning changed files into one batched judgement, and its answers into a
 * verdict per file.
 *
 * The rule the whole module exists to hold: a file is skipped only when it
 * scored below the line **and** the model was confident about it. Every other
 * outcome — a high score, low confidence, a failed call, a binary file, a file
 * past a budget, a missing answer — is a review. Skipping something risky is
 * therefore not a thing that can happen; the worst case is a review nobody
 * needed.
 * @module @zhchxiao123/dsh-jev-triage/triage
 */

import { JevError } from '@zhchxiao123/dsh-jev'
import type { JevRuntime, Question } from '@zhchxiao123/dsh-jev'
import type { ResolvedConfig } from './config.ts'
import type { ChangedFile } from './diff.ts'

/** What triage decided about one file. */
export interface FileVerdict {
  readonly path: string
  /** `review` or `skip`. */
  readonly action: 'review' | 'skip'
  readonly score?: number
  readonly level?: string
  readonly confidence?: number
  /** Why this is not a skip. Absent on a skip, and on an ordinary review. */
  readonly reason?: string
  readonly diffChars?: number
}

/** The whole triage result. */
export interface TriageResult {
  readonly available: boolean
  readonly files: FileVerdict[]
  readonly review_count: number
  readonly skip_count: number
  readonly note?: string
}

/**
 * Name each rubric level from its own description.
 *
 * A level reads `Name: what it covers`, so the name is what precedes the first
 * colon. Deriving it keeps the rubric the only place a level is named.
 *
 * @param levels - the rubric.
 * @returns one lower-case name per level.
 */
export function levelNames(levels: readonly string[]): readonly string[] {
  return levels.map((line) => {
    const colon = line.indexOf(':')
    return (colon >= 0 ? line.slice(0, colon) : line).trim().toLowerCase()
  })
}

/** One file's question, and the characters it spends. */
interface BuiltQuestion {
  readonly question: Question
  readonly chars: number
}

/**
 * Build the question for one file.
 *
 * The file's own diff rides in its **own** `instructions`, not in the shared
 * state: every question in a call is answered against the same state, so a
 * state holding every file's diff would let the files anchor each other.
 *
 * @param file - the changed file.
 * @param config - the rubric and the per-file budget.
 * @returns the question and the characters of diff it carries.
 */
export function buildQuestion(file: ChangedFile, config: ResolvedConfig): BuiltQuestion {
  const truncated = file.chunk.length > config.maxFileChars
  const diff = truncated ? `${file.chunk.slice(0, config.maxFileChars)}\n... (truncated)` : file.chunk
  return {
    question: {
      type: 'score',
      instructions: { task: config.scoreInstruction, file: file.path, diff },
      criteria: [...config.scoreLevels] as [string, string, ...string[]],
    },
    chars: diff.length,
  }
}

/** The shared evidence: only what is true of every question in the call. */
export function buildState(cwd: string): Record<string, string> {
  return {
    task: 'Git working-tree diff triage',
    repository: cwd,
    note: 'Each question below carries one changed file and its full diff; judge only the file inside the question you are answering.',
  }
}

/**
 * Triage one set of changed files.
 *
 * @param jev - the judgement seam.
 * @param files - every changed file the diff listed.
 * @param cwd - the repository, for the shared state.
 * @param config - thresholds and budgets.
 * @param signal - cancellation for the judgement call.
 * @returns a verdict for every file, and a note when something was degraded.
 * @throws JevError when the caller withdrew the request. Every other failure
 *   becomes a review, because a triage that cannot judge must not be a triage
 *   that skips.
 */
export async function triage(
  jev: JevRuntime,
  files: readonly ChangedFile[],
  cwd: string,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<TriageResult> {
  if (files.length === 0) {
    return {
      available: true,
      files: [],
      review_count: 0,
      skip_count: 0,
      note: 'No tracked changes found. Untracked files are not triaged; list them with git status.',
    }
  }

  const verdicts: FileVerdict[] = []
  const notes: string[] = []
  const scorable: ChangedFile[] = []
  for (const file of files) {
    if (file.binary) {
      verdicts.push({ path: file.path, action: 'review', reason: 'binary file, nothing to read' })
    } else {
      scorable.push(file)
    }
  }

  const batch = scorable.slice(0, config.maxFiles)
  for (const file of scorable.slice(config.maxFiles)) {
    verdicts.push({ path: file.path, action: 'review', reason: `beyond the ${String(config.maxFiles)}-file batch` })
  }
  if (scorable.length > config.maxFiles) {
    notes.push(`${String(scorable.length - config.maxFiles)} file(s) past the batch size default to review.`)
  }

  const questions: Record<string, Question> = {}
  const asked: ChangedFile[] = []
  let spent = 0
  for (const file of batch) {
    const built = buildQuestion(file, config)
    if (spent + built.chars > config.maxTotalChars) {
      verdicts.push({ path: file.path, action: 'review', reason: 'diff too large for this call; triage it separately' })
      continue
    }
    spent += built.chars
    questions[`f${String(asked.length)}`] = built.question
    asked.push(file)
  }
  if (asked.length < batch.length) notes.push('Some diffs exceeded the per-call character budget and default to review.')

  if (asked.length > 0) {
    let answers
    try {
      const response = await jev.ask({ state: buildState(cwd), questions }, signal)
      answers = response.answers
    } catch (error: unknown) {
      // Cancellation is the caller's decision, not an unavailable judgement. A
      // withdrawn call that came back with a full set of conservative verdicts
      // would look like it had succeeded.
      if (error instanceof JevError && error.code === 'JEV_ABORTED') throw error
      const code = error instanceof JevError ? error.code : 'JEV_UNAVAILABLE'
      for (const file of asked) {
        verdicts.push({ path: file.path, action: 'review', reason: `judgement unavailable (${code})`, diffChars: file.chunk.length })
      }
      notes.push('The judgement call failed, so every file it covered defaults to review.')
      return settle(verdicts, notes)
    }
    const names = levelNames(config.scoreLevels)
    asked.forEach((file, index) => {
      verdicts.push(decide(file, answers[`f${String(index)}`], config, names))
    })
  }

  return settle(verdicts, notes)
}

/**
 * Decide one file from its answer.
 *
 * Confidence is checked before the score: a low-confidence answer is a review
 * whatever it scored, and saying so is more useful than reporting the score
 * that was not trusted.
 *
 * @param file - the file judged.
 * @param answer - its answer, when one came back.
 * @param config - the thresholds.
 * @param names - the level names, from {@link levelNames}.
 * @returns the verdict.
 */
export function decide(
  file: ChangedFile,
  answer: { readonly type: string; readonly score?: number; readonly confidence?: number } | undefined,
  config: ResolvedConfig,
  names: readonly string[],
): FileVerdict {
  const diffChars = file.chunk.length
  if (answer === undefined) {
    return { path: file.path, action: 'review', reason: 'no answer came back for this file', diffChars }
  }
  if (answer.type !== 'score' || typeof answer.score !== 'number' || typeof answer.confidence !== 'number') {
    return { path: file.path, action: 'review', reason: 'the answer was not a score', diffChars }
  }
  const score = answer.score
  const confidence = answer.confidence
  const level = names[Math.min(names.length - 1, Math.max(0, Math.round(score)))]
  const common = { path: file.path, score, confidence, diffChars, ...level === undefined ? {} : { level } }
  if (confidence < config.confidenceFloor) {
    return { ...common, action: 'review', reason: `confidence below ${String(config.confidenceFloor)}` }
  }
  return score < config.skipBelow ? { ...common, action: 'skip' } : { ...common, action: 'review' }
}

/**
 * Count the verdicts and check that every file landed in exactly one bucket.
 *
 * @param files - every verdict produced.
 * @param notes - degradations worth reporting.
 * @returns the result.
 */
function settle(files: FileVerdict[], notes: readonly string[]): TriageResult {
  let review = 0
  let skip = 0
  for (const file of files) {
    if (file.action === 'skip') skip += 1
    else review += 1
  }
  return {
    available: true,
    files,
    review_count: review,
    skip_count: skip,
    ...notes.length > 0 ? { note: notes.join(' ') } : {},
  }
}
