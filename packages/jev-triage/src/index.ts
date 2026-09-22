/**
 * `jev_triage`: score each changed file in a git working tree for review risk,
 * so a code review spends its expensive attention on the parts that need it.
 *
 * This is a Consumer of `ctx.jev` and knows nothing about which provider
 * answers. It never imports a provider package, and its specs mount an
 * in-memory judgement instead — which is what makes "the backend is swappable"
 * a checked property rather than an intention.
 * @module @zhchxiao123/dsh-jev-triage
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@zhchxiao123/dsh-jev'
import { Config, assertConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { runGitDiff, splitDiff } from './diff.ts'
import type { DiffError } from './diff.ts'
import { presentationMeta, render } from './present.ts'
import { triage } from './triage.ts'
import type { TriageResult } from './triage.ts'

export { Config, assertConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { DiffError, headerPath, quote, runGitDiff, splitDiff } from './diff.ts'
export type { ChangedFile } from './diff.ts'
export { presentationMeta, render } from './present.ts'
export { buildQuestion, buildState, decide, levelNames, triage } from './triage.ts'
export type { FileVerdict, TriageResult } from './triage.ts'

/** Cordis plugin name, as the Loader reports it. */
export const name = 'jev-triage'
/**
 * All three are required. Without `jev` the tool has nothing to ask, without
 * `shell` nothing to read, and without `tools` nowhere to register — deferring
 * activation is more honest than a tool that answers every call with the same
 * apology.
 */
export const inject = ['tools', 'jev', 'shell']

/** One verdict, as the tool's output schema declares it. */
const FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true, description: 'Repository-relative path of the changed file.' },
    action: { type: 'string', required: true, description: '"review" or "skip".' },
    score: { type: 'number', description: 'Position on the rubric; may fall between levels.' },
    level: { type: 'string', description: 'Name of the nearest rubric level.' },
    confidence: { type: 'number', description: 'How concentrated the judgement was.' },
    reason: { type: 'string', description: 'Why this is not a skip. Absent on a skip and on an ordinary review.' },
    diffChars: { type: 'number', description: 'Characters in this file\'s diff.' },
  },
} as const

/**
 * Register the tool.
 *
 * The registration is unconditional. A composition that mounts this row without
 * a usable judgement gets a tool that says so when called, which is a better
 * failure than a tool table that changes shape with credential state: the tool
 * list is part of a request's header, so a table that comes and goes both
 * breaks prefix caching and leaves "where did that tool go" as the diagnosis.
 *
 * @param ctx - the context to register on.
 * @param config - the reviewed triage configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const resolved: ResolvedConfig = config

  ctx.tools.register(defineTool({
    name: 'jev_triage',
    description:
      'Score each changed file in a git working tree for review risk, before starting a code review. '
      + 'Every file is judged on its own in one batched call. A file comes back "skip" only when it '
      + 'scored low AND the judgement was confident; every other outcome, including every uncertain '
      + 'one, comes back "review". Run this before dispatching review work so the expensive reading '
      + 'goes to the files that need it. Untracked files are not covered — list those with git status.',
    parameters: {
      cwd: {
        type: 'string',
        required: true,
        description: 'Absolute path of the git repository to triage.',
      },
      base: {
        type: 'string',
        description: 'Git ref to diff against (branch, tag, or SHA). Omit to cover all uncommitted changes against HEAD.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          files: { type: 'array', required: true, items: FILE_SCHEMA },
          review_count: { type: 'number', required: true },
          skip_count: { type: 'number', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => render(value as TriageResult),
      presentationMeta: (_args, value) => presentationMeta(value as TriageResult),
    },
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => {
      if (!args.cwd.startsWith('/')) {
        return unavailable(`cwd must be an absolute repository path, not ${JSON.stringify(args.cwd)}`)
      }
      exec.signal.throwIfAborted()
      let files
      try {
        const diff = await runGitDiff(ctx, args.cwd, args.base, resolved, exec.signal)
        files = splitDiff(diff)
      } catch (error: unknown) {
        // `runGitDiff` reports every way of failing as a DiffError, so there is
        // one shape to read here. Any of them stops triage: with no complete
        // diff there is nothing to judge, and the tool's promise is that not
        // judging means reviewing.
        return unavailable((error as DiffError).message)
      }
      exec.signal.throwIfAborted()
      return await triage(ctx.jev, files, args.cwd, resolved, exec.signal)
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'read',
      title: 'Jev triage',
      rawInput: args.base === undefined ? args.cwd : `${args.cwd} (vs ${args.base})`,
    }),
  }))
}

/**
 * The shape triage takes when it could not run at all.
 *
 * @param note - why, in terms a reviewer can act on.
 * @returns the result.
 */
function unavailable(note: string): TriageResult {
  return { available: false, files: [], review_count: 0, skip_count: 0, note }
}
