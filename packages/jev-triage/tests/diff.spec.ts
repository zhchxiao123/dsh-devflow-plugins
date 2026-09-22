// Reading the working tree. Two things here are load-bearing: every value
// interpolated into the command is quoted, because both of them come from the
// model; and a truncated capture is a fault, because half a file's diff still
// parses and would be scored as though it were the whole change.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DiffError, headerPath, quote, runGitDiff, splitDiff } from '@zhchxiao123/dsh-jev-triage'
import { ScriptedShell, textDiff } from './doubles.ts'

const LIMITS = { stdoutMaxBytes: 4096, timeoutMs: 1000 }

async function mountShell(): Promise<{ ctx: Context; shell: ScriptedShell }> {
  const ctx = new Context()
  await ctx.plugin(ScriptedShell)
  return { ctx, shell: ctx.shell as ScriptedShell }
}

describe('quote', () => {
  it.each([
    ['a plain path', '/repo', "'/repo'"],
    ['a space', '/my repo', "'/my repo'"],
    ['a single quote', "/it's", "'/it'\\''s'"],
    ['a dollar sign', '/repo/$HOME', "'/repo/$HOME'"],
    ['a backtick', '/repo/`whoami`', "'/repo/`whoami`'"],
    ['a newline', '/repo\nrm -rf /', "'/repo\nrm -rf /'"],
    ['a semicolon', '/repo; rm -rf /', "'/repo; rm -rf /'"],
  ])('quotes %s', (_label, raw, expected) => {
    expect(quote(raw)).toBe(expected)
  })
})

describe('headerPath', () => {
  it.each([
    ['a plain header', 'diff --git a/src/index.ts b/src/index.ts', 'src/index.ts'],
    ['a quoted header', 'diff --git "a/my file.ts" "b/my file.ts"', 'my file.ts'],
    ['a rename', 'diff --git a/old.ts b/new.ts', 'new.ts'],
  ])('reads %s', (_label, line, expected) => {
    expect(headerPath(line)).toBe(expected)
  })

  it('falls back to what the header actually said when it cannot be read', () => {
    expect(headerPath('diff --git something-unexpected')).toBe('something-unexpected')
    // A header with nothing after the marker yields the line itself, which a
    // human can at least recognize.
    expect(headerPath('diff --git ')).toBe('diff --git ')
  })
})

describe('splitDiff', () => {
  it('returns nothing for an empty diff', () => {
    expect(splitDiff('')).toEqual([])
  })

  it('cuts one entry per file, keeping each header', () => {
    const files = splitDiff(`${textDiff('a.ts')}\n${textDiff('b.ts')}`)
    expect(files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(files[0]?.chunk.startsWith('diff --git a/a.ts')).toBe(true)
  })

  it.each([
    ['a textual "Binary files" line', 'Binary files a/logo.png and b/logo.png differ'],
    ['a binary patch', 'GIT binary patch'],
  ])('marks %s as unreadable', (_label, marker) => {
    const files = splitDiff(`diff --git a/logo.png b/logo.png\n${marker}`)
    expect(files[0]?.binary).toBe(true)
  })

  it('ignores anything before the first header', () => {
    expect(splitDiff(`warning: noise\n${textDiff('a.ts')}`).map(file => file.path)).toEqual(['a.ts'])
  })
})

describe('runGitDiff', () => {
  it('quotes both the repository and the ref, and forces canonical prefixes', async () => {
    const { ctx, shell } = await mountShell()
    shell.setOutcome({ stdout: textDiff('a.ts') })
    await runGitDiff(ctx, "/my repo/it's", 'ma in', LIMITS, new AbortController().signal)
    const command = shell.commands[0] ?? ''
    expect(command).toContain("git -C '/my repo/it'\\''s' diff")
    expect(command).toContain("'ma in'")
    expect(command).toContain('--src-prefix=a/ --dst-prefix=b/ --no-ext-diff')
  })

  it('diffs against HEAD when no ref is given', async () => {
    const { ctx, shell } = await mountShell()
    shell.setOutcome({ stdout: '' })
    await runGitDiff(ctx, '/repo', undefined, LIMITS, new AbortController().signal)
    expect(shell.commands[0]?.endsWith(' HEAD')).toBe(true)
  })

  it.each([
    ['a truncated capture', { stdout: 'half a diff', truncated: true }, 'more than 4096 bytes'],
    ['a timeout', { timedOut: true }, 'exceeded'],
    ['a cancellation', { aborted: true }, 'cancelled'],
    ['a non-zero exit with stderr', { exitCode: 128, stderr: 'not a git repository' }, 'not a git repository'],
    ['a non-zero exit with nothing to say', { exitCode: 3 }, 'exit 3'],
    ['an executor fault', { throws: new Error('no shell available') }, 'no shell available'],
  ])('faults on %s', async (_label, outcome, message) => {
    const { ctx, shell } = await mountShell()
    shell.setOutcome(outcome)
    await expect(runGitDiff(ctx, '/repo', undefined, LIMITS, new AbortController().signal))
      .rejects.toThrow(DiffError)
    await expect(runGitDiff(ctx, '/repo', undefined, LIMITS, new AbortController().signal))
      .rejects.toThrow(message)
  })

  it('faults on an executor fault that threw a non-error', async () => {
    const { ctx, shell } = await mountShell()
    shell.setOutcome({ throws: 'string throw' as unknown as Error })
    await expect(runGitDiff(ctx, '/repo', undefined, LIMITS, new AbortController().signal))
      .rejects.toThrow('string throw')
  })
})
