/**
 * Extension-keyed dispatch to the language evaluators.
 *
 * A file no evaluator claims is unevaluable for symbolic anchors, never fresh:
 * only a churn anchor can watch it, and the caller owns saying so in the
 * vocabulary its consumers already quote.
 * @module @zhchxiao123/dsh-devflow-spec-filesystem/src/evaluators/registry
 */

import { goEvaluator } from './go.ts'
import { javaEvaluator } from './java.ts'
import { pythonEvaluator } from './python.ts'
import { rustEvaluator } from './rust.ts'
import { typescriptEvaluator } from './typescript.ts'
import type { LanguageEvaluator } from './types.ts'

/** Every registered evaluator; adding a language is one entry here. */
const EVALUATORS: readonly LanguageEvaluator[] = [typescriptEvaluator, pythonEvaluator, goEvaluator, rustEvaluator, javaEvaluator]

/**
 * The evaluator claiming one anchored file's extension.
 * @param file - the anchor's repository-relative file path.
 * @returns the evaluator, or `undefined` when no language claims the file.
 */
export function evaluatorFor(file: string): LanguageEvaluator | undefined {
  return EVALUATORS.find(evaluator => evaluator.extensions.some(extension => file.endsWith(extension)))
}
