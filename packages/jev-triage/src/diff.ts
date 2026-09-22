/**
 * Getting the working tree's diff and cutting it into one chunk per file.
 *
 * `ctx.shell` takes a command **string**, not an argument vector, so every
 * value interpolated into it is quoted here. Both values that reach this module
 * — the repository path and the ref — arrive from the model, and an unquoted
 * one would let a repository's own file names decide what runs.
 * @module @zhchxiao123/dsh-jev-triage/diff
 */

import type { Context } from '@deepseek-ai/cordis'

/** One changed file and the diff that describes it. */
export interface ChangedFile {
  /** Post-change path, as the diff header names it. */
  readonly path: string
  /** True when the diff carries no readable text to judge. */
  readonly binary: boolean
  /** This file's own diff, header included. */
  readonly chunk: string
}

/** What `git diff` could not do. */
export class DiffError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DiffError'
  }
}

/**
 * Quote one value for a POSIX shell.
 *
 * @param value - the raw value.
 * @returns the value as a single-quoted word.
 */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Read the changed path out of one `diff --git` header.
 *
 * The b/ side is the post-change path. A path carrying a space or a control
 * character arrives quoted, so the quotes come off. A header this cannot read
 * yields the header line itself rather than a placeholder, because a human
 * looking at the result can act on the former and not on the latter.
 *
 * @param line - one `diff --git` header line.
 * @returns the changed path.
 */
export function headerPath(line: string): string {
  const match = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line)
  if (match?.[2] !== undefined) return match[2]
  const raw = line.slice('diff --git '.length).trim()
  return raw.length > 0 ? raw : line
}

/**
 * Cut a unified diff into one entry per file.
 *
 * @param diff - the full `git diff` output.
 * @returns one entry per changed file, in the order the diff listed them.
 */
export function splitDiff(diff: string): readonly ChangedFile[] {
  const files: { path: string; binary: boolean; lines: string[] }[] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files.push({ path: headerPath(line), binary: false, lines: [line] })
      continue
    }
    const current = files.at(-1)
    if (current === undefined) continue
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) current.binary = true
    current.lines.push(line)
  }
  return files.map(file => ({ path: file.path, binary: file.binary, chunk: file.lines.join('\n') }))
}

/**
 * Run `git diff` in one repository and return what it printed.
 *
 * `--src-prefix` and `--dst-prefix` force the canonical `a/` `b/` headers the
 * splitter reads, whatever `diff.mnemonicPrefix` is set to locally, and
 * `--no-ext-diff` forbids an external driver from replacing the output shape
 * entirely.
 *
 * @param ctx - context carrying `ctx.shell`.
 * @param cwd - absolute path of the repository.
 * @param base - ref to diff against; `HEAD` when absent.
 * @param limits - output budget and deadline.
 * @param signal - cancellation for the run.
 * @returns the diff text.
 * @throws DiffError when git fails, is killed, or its output is truncated.
 */
export async function runGitDiff(
  ctx: Context,
  cwd: string,
  base: string | undefined,
  limits: { stdoutMaxBytes: number; timeoutMs: number },
  signal: AbortSignal,
): Promise<string> {
  const ref = base === undefined ? 'HEAD' : quote(base)
  const command = `git -C ${quote(cwd)} diff --no-color --src-prefix=a/ --dst-prefix=b/ --no-ext-diff ${ref}`
  let result
  try {
    result = await ctx.shell.run(ctx.shell.resolve({
      command,
      timeoutMs: limits.timeoutMs,
      stdoutMaxBytes: limits.stdoutMaxBytes,
      signal,
    }))
  } catch (error: unknown) {
    throw new DiffError(`git diff could not run: ${describe(error)}`, { cause: error })
  }
  if (result.timedOut) throw new DiffError(`git diff exceeded ${String(result.timeoutMs)}ms`)
  if (result.aborted) throw new DiffError('git diff was cancelled')
  if (result.exitCode !== 0) {
    const detail = result.stderr.text.trim()
    throw new DiffError(`git diff failed: ${detail.length > 0 ? detail : `exit ${String(result.exitCode)}`}`)
  }
  // A truncated capture is a fault, not a smaller diff. Half of a file's diff
  // still parses, and the model would score it as though it were the whole
  // change — a wrong answer with nothing to mark it as one.
  if (result.stdout.truncated) {
    throw new DiffError(
      `git diff produced more than ${String(limits.stdoutMaxBytes)} bytes; raise stdoutMaxBytes or triage a narrower range`,
    )
  }
  return result.stdout.text
}

/**
 * Render a thrown value as a short message.
 *
 * @param error - the thrown value.
 * @returns its message, or its string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
