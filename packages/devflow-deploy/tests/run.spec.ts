import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { DeployFailure, DeployRunContext, shellArgv } from '../src/run.ts'
import type { RunSettings } from '../src/run.ts'

const AT = new Date('2026-09-03T19:45:07.123Z')

declare const process: { readonly platform: string; readonly env: Record<string, string | undefined> }

const disposers: (() => void)[] = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
})

async function runContext(overrides: Partial<RunSettings> = {}): Promise<DeployRunContext> {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  disposers.push(() => void fiber.dispose())
  const root = await mkdtemp(join(tmpdir(), 'deploy-run-'))
  return new DeployRunContext(ctx, {
    root,
    remoteTimeoutMs: 10_000,
    logTailBytes: 65_536,
    graceMs: 1_000,
    clock: () => AT,
    ...overrides,
  })
}

describe('shellArgv', () => {
  it('merges stderr into the collected stdout stream', () => {
    expect(shellArgv('echo hi')).toEqual(['sh', '-c', 'exec 2>&1\necho hi'])
  })
})

describe('releaseId', () => {
  it('is a sortable wall-clock stamp', async () => {
    const run = await runContext()

    expect(run.releaseId()).toBe('20260903T194507Z')
  })
})

describe('exec', () => {
  it('reports a successful command with its captured output', async () => {
    const run = await runContext()

    const result = await run.exec(shellArgv('echo hello'))

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output.trim()).toBe('hello')
    expect(result.timedOut).toBe(false)
  })

  it('returns a non-zero exit rather than throwing', async () => {
    const run = await runContext()

    const result = await run.exec(shellArgv('echo nope >&2; exit 3'))

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('nope')
  })

  it('runs in a directory resolved against the workspace root', async () => {
    const run = await runContext()
    await writeFile(join(run.root, 'marker'), 'x')

    const result = await run.exec(shellArgv('ls marker'), { cwd: '.' })

    expect(result.output).toContain('marker')
  })

  it('terminates a command that outruns its deadline', async () => {
    const run = await runContext()

    const result = await run.exec(shellArgv('sleep 30'), { timeoutMs: 1_000 })

    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('fails loud when the executable cannot be spawned', async () => {
    const run = await runContext()

    await expect(run.exec(['definitely-not-on-path-xyz'])).rejects.toThrow(DeployFailure)
  })

  it('names the missing command when the spec carries no argv at all', async () => {
    const run = await runContext()

    await expect(run.exec([])).rejects.toThrow('(no command)')
  })

  it('keeps stderr distinguishable when the command does not merge it', async () => {
    const run = await runContext()

    const result = await run.exec(['sh', '-c', 'echo out; echo err >&2'])

    expect(result.output).toContain('out')
    expect(result.output).toContain('--- stderr ---')
    expect(result.output).toContain('err')
  })

  it('forwards SSH_AUTH_SOCK, which is what makes ambient SSH authentication work', async () => {
    const run = await runContext()
    process.env['SSH_AUTH_SOCK'] = '/tmp/agent.test.sock'
    disposers.push(() => {
      delete process.env['SSH_AUTH_SOCK']
    })

    const result = await run.exec(shellArgv('printf %s "$SSH_AUTH_SOCK"'))

    expect(result.output).toBe('/tmp/agent.test.sock')
  })
})

describe('mustExec', () => {
  it('returns the result of a command that exits zero', async () => {
    const run = await runContext()

    await expect(run.mustExec(shellArgv('true'))).resolves.toMatchObject({ ok: true })
  })

  it('throws the command, its ending, and its output tail, tagged with the phase', async () => {
    const run = await runContext()
    run.phase('build')

    let caught: DeployFailure | undefined
    try {
      await run.mustExec(shellArgv('echo boom; exit 2'))
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.phase).toBe('build')
    expect(caught?.message).toContain('build: a command failed')
    expect(caught?.message).toContain('command: sh -c')
    expect(caught?.message).toContain('ended: exit code 2')
    expect(caught?.message).toContain('boom')
    expect(caught?.result?.exitCode).toBe(2)
  })

  it('names the signal when a command is killed rather than exiting', async () => {
    const run = await runContext()

    const ending = process.platform === 'win32' ? 'exit code 3840' : 'killed by SIGTERM'
    await expect(run.mustExec(shellArgv('kill -TERM $$'))).rejects.toThrow(`ended: ${ending}`)
  })

  it('names a timeout rather than an exit code', async () => {
    const run = await runContext()

    await expect(run.mustExec(shellArgv('sleep 30'), { timeoutMs: 1_000 }))
      .rejects.toThrow(/timed out after \d+ms/)
  })

  it('omits the output block when the command printed nothing', async () => {
    const run = await runContext()

    await expect(run.mustExec(shellArgv('exit 1'))).rejects.not.toThrow(/output:/)
  })
})

describe('the phase timeline', () => {
  it('closes each phase as the next opens and leaves the last one open', async () => {
    const run = await runContext()

    run.phase('build')
    run.phase('preflight')
    run.phase('preflight')

    expect(run.timeline().map(entry => entry.phase)).toEqual(['resolve', 'build', 'preflight'])
    expect(run.timeline().every(entry => entry.durationMs >= 0)).toBe(true)
  })

  it('starts in resolve', async () => {
    const run = await runContext()

    expect(run.activePhase).toBe('resolve')
    expect(run.timeline().map(entry => entry.phase)).toEqual(['resolve'])
  })
})

describe('warnings', () => {
  it('records non-fatal defects in order without failing the run', async () => {
    const run = await runContext()

    run.warn('old release could not be pruned')
    run.warn('temporary file left behind')

    expect(run.recordedWarnings()).toEqual([
      'old release could not be pruned',
      'temporary file left behind',
    ])
  })

  it('hands back a copy so a caller cannot mutate the record', async () => {
    const run = await runContext()
    run.warn('one')

    const first = run.recordedWarnings() as string[]
    first.push('two')

    expect(run.recordedWarnings()).toEqual(['one'])
  })
})
