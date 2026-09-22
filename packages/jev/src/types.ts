/**
 * Vocabulary for the typed-judgement seam, free of runtime values so a consumer
 * can import the words without pulling in this package's `Context` augmentation.
 *
 * The four terms are fixed: a **State** is the evidence one call evaluates, a
 * **Question** is one typed judgement asked against it, an **Answer** carries
 * the verdict together with the distribution behind it, and one **ask** is a
 * single State plus a set of Questions answered in parallel.
 * @module @zhchxiao123/dsh-jev/types
 */

/** Any value that survives a JSON round trip. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/**
 * Prose, or structure when prose is not enough. A long question that carries
 * data it must refer to reads better as an object — the question in one field,
 * the data in others, referenced from the question by backticked field name.
 *
 * Deliberately narrower than {@link JsonValue}: a bare number or boolean is not
 * something a reader reads, so it cannot be evidence, an instruction, or the
 * description of a level. Wrap it in a named field instead.
 */
export type Description =
  | string
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[]
  | null

/** Which kind of judgement a {@link Question} asks for. */
export type QuestionType = 'choice' | 'score' | 'noul'

/** Pick exactly one option from a defined set. */
export interface ChoiceQuestion {
  readonly type: 'choice'
  /** What to decide. */
  readonly instructions: Description
  /** Option to its rubric; `null` where an option needs no elaboration. */
  readonly criteria: Readonly<Record<string, Description | null>>
}

/** Rate along an ordered, described dimension. */
export interface ScoreQuestion {
  readonly type: 'score'
  /** What to rate. */
  readonly instructions: Description
  /**
   * The ordered levels; the index of a level is its score. At least two are
   * required — one level has nothing to discriminate. Each level must describe
   * a concrete situation and stand on its own, because the answer is a
   * position among these descriptions and nothing else.
   */
  readonly criteria: readonly [Description, Description, ...Description[]]
}

/** Ask whether a condition holds. */
export interface NoulQuestion {
  readonly type: 'noul'
  /** The yes/no question to evaluate. */
  readonly instructions: Description
  /** Optional: what a yes and a no each mean. */
  readonly criteria?: {
    readonly true?: Description
    readonly false?: Description
  }
}

/** One typed judgement. */
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion

/** The selected option, with the distribution it was selected from. */
export interface ChoiceAnswer {
  readonly type: 'choice'
  /** The chosen option key. */
  readonly choice: string
  /** Probability per option, keyed as the question's `criteria` was. */
  readonly probabilities: Readonly<Record<string, number>>
  /** How concentrated the distribution is — not a claim about correctness. */
  readonly confidence: number
}

/** A probability-weighted position on the question's levels. */
export interface ScoreAnswer {
  readonly type: 'score'
  /**
   * The rated level. Probability-weighted, so it may fall between two integer
   * levels: a threshold on it is a threshold on a position, not on a label.
   */
  readonly score: number
  /** Probability per level, index-aligned with the question's `criteria`. */
  readonly probabilities: readonly number[]
  /** How concentrated the distribution is — not a claim about correctness. */
  readonly confidence: number
}

/**
 * The probability that the answer is yes. A Noul carries no separate
 * confidence: a value near 0.5 means yes and no are near-equally likely, which
 * is a statement about the question, not a weaker version of one.
 */
export interface NoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

/** One typed answer. */
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer

/** One judgement call: a State plus the Questions asked against it. */
export interface JevRequest {
  /**
   * The evidence every question evaluates against, independently. Shared
   * context belongs here; anything true of only one question belongs in that
   * question's `instructions`.
   */
  readonly state: Description
  /**
   * The questions, under keys the caller chooses. Answers come back under the
   * same keys. A key is addressing for code and is not part of the judgement,
   * so each question must carry its full meaning in its own fields.
   */
  readonly questions: Readonly<Record<string, Question>>
}

/** What one call consumed, when the provider reports it. */
export interface JevUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** The result of one judgement call. */
export interface JevResponse {
  /**
   * Answers under the keys they were asked under. A question that went
   * unanswered is **absent** rather than present-and-empty, so a caller can
   * always tell "judged as zero" from "not judged".
   */
  readonly answers: Readonly<Record<string, Answer>>
  /** Consumption, when the provider reports it. */
  readonly usage?: JevUsage
  /** Which model actually answered, for the caller's own records. */
  readonly model?: string
}
