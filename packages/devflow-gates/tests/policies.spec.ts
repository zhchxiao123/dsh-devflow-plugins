// Per-edge execution policy: the timeout and working directory handed to the
// shell executor, concurrent command execution, and the failure log that keeps
// the veto summary from being the only record of what a gate printed.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor, TransitionResult } from '@zhchxiao123/dsh-devflow'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as DevflowGates from '@zhchxiao123/dsh-devflow-gates'

const HUMAN: DevActor = { kind: 'human', name: 'byclaw' }

/**
 * A resolvable promise, spelled out rather than taken from
 * `Promise.withResolvers`: the linter builds no program for files outside the
 * packages' `include: ["src"]`, so it has neither the ES2024 lib nor our
 * tsconfig and reads that call as an error type.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Records the resolved spec of every command, and settles them on demand. */
class ScriptedExecutor extends ShellExecutor {
  readonly specs: ShellExecSpec[] = []
  readonly started: string[] = []
  constructor(
    ctx: Context,
    private readonly script: Record<string, { exitCode: number | null; stdout?: string; stderr?: string; holds?: Promise<void> }>,
  ) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/scripted',
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec)
    this.started.push(spec.command)
    const entry = this.script[spec.command]
    if (entry === undefined) throw new Error(`unscripted gate command: ${spec.command}`)
    if (entry.holds !== undefined) await entry.holds
    return {
      exitCode: entry.exitCode,
      signal: entry.exitCode === null ? 'SIGKILL' : null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: entry.stdout ?? '', truncated: false },
      stderr: { text: entry.stderr ?? '', truncated: false },
    }
  }

  start(): ShellProcess {
    throw new Error('gates never start background processes')
  }
}

const DEVELOPING = [
  '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
  '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
  '{"rev":3,"at":"t3","type":"transition","from":"designing","to":"ready"}',
  '{"rev":4,"at":"t4","type":"transition","from":"ready","to":"developing"}',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(
  script: Record<string, { exitCode: number | null; stdout?: string; stderr?: string; holds?: Promise<void> }>,
  config: DevflowGates.Config,
): Promise<{ store: FilesystemDevflowStore; shell: ScriptedExecutor }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devflow-policies-'))
  const dir = join(root, 'tasks', '0001-a')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), '---\ntitle: Card\n---\nbody\n')
  await writeFile(join(dir, 'journal.jsonl'), DEVELOPING.join('\n') + '\n')
  const ctx = new Context()
  context = ctx
  let shell!: ScriptedExecutor
  await ctx.plugin((child: Context) => { shell = new ScriptedExecutor(child, script) })
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  await ctx.plugin(DevflowGates, config).await()
  return { store: ctx.get('devflow') as FilesystemDevflowStore, shell }
}

function review(store: FilesystemDevflowStore): Promise<TransitionResult> {
  return store.transition(store.resolve({
    id: DevflowCardId('0001-a'), to: 'reviewing', expectedRevision: 4, by: HUMAN,
  }))
}

describe('devflow-gates edge policies', () => {
  it('hands the edge its own timeout and working directory', async () => {
    const { store, shell } = await boot(
      { suite: { exitCode: 0 } },
      {
        edges: { 'developing->reviewing': ['suite'] },
        policies: { 'developing->reviewing': { timeoutMs: 900_000, workdir: '/elsewhere' } },
      },
    )
    expect((await review(store)).ok).toBe(true)
    expect(shell.specs[0]).toMatchObject({ command: 'suite', timeoutMs: 900_000, workdir: '/elsewhere' })
  })

  it('leaves an unpoliced edge on the executor defaults, in the card workspace', async () => {
    const { store, shell } = await boot(
      { check: { exitCode: 0 } },
      { edges: { 'developing->reviewing': ['check'] } },
    )
    expect((await review(store)).ok).toBe(true)
    // The workspace is the parent of the devflow root; the timeout is whatever
    // the executor resolved.
    expect(shell.specs[0].workdir).toBe(join(root!, '..'))
    expect(shell.specs[0].timeoutMs).toBe(1000)
  })

  it('stops at the first failure when the edge is sequential', async () => {
    const { store, shell } = await boot(
      { first: { exitCode: 1, stderr: 'first blew up' }, second: { exitCode: 0 } },
      { edges: { 'developing->reviewing': ['first', 'second'] } },
    )
    const result = await review(store)
    expect(result).toMatchObject({ ok: false, code: 'vetoed' })
    expect(shell.started).toEqual(['first'])
  })

  it('runs every command and names each failure when the edge is parallel', async () => {
    const held = deferred()
    const { store, shell } = await boot(
      {
        slow: { exitCode: 1, stderr: 'slow failed', holds: held.promise },
        quick: { exitCode: 1, stderr: 'quick failed' },
        fine: { exitCode: 0 },
      },
      {
        edges: { 'developing->reviewing': ['slow', 'quick', 'fine'] },
        policies: { 'developing->reviewing': { parallel: true } },
      },
    )
    const moving = review(store)
    // All three are in flight before the slow one settles: sequential would
    // still be waiting on `slow`.
    await vi.waitFor(() => { expect(shell.started).toHaveLength(3) })
    held.resolve()
    const result = await moving
    expect(result).toMatchObject({ ok: false, code: 'vetoed' })
    const message = (result as { message: string }).message
    expect(message).toContain('slow failed')
    expect(message).toContain('quick failed')
    expect(message).not.toContain('fine')
  })

  it('writes the complete output of a failed command and names the file', async () => {
    const logs = await mkdtemp(join(tmpdir(), 'dsh-devflow-gatelogs-'))
    try {
      const shouting = 'x'.repeat(5000)
      const { store } = await boot(
        { suite: { exitCode: 3, stdout: shouting, stderr: 'the tail' } },
        {
          edges: { 'developing->reviewing': ['suite'] },
          maxFailureOutputChars: 40,
          failureLogDir: logs,
        },
      )
      const result = await review(store)
      const message = (result as { message: string }).message
      expect(message).toContain('(truncated)')

      const written = await readdir(logs)
      expect(written).toEqual(['0001-a-developing-to-reviewing-0.log'])
      const logPath = join(logs, written[0])
      expect(message).toContain(`full output: ${logPath}`)
      const body = await readFile(logPath, 'utf8')
      expect(body).toContain('command: suite')
      expect(body).toContain('exit 3')
      expect(body).toContain('the tail')
      // The whole output, not the summary's 40 characters.
      expect(body).toContain(shouting)
    } finally {
      await rm(logs, { recursive: true, force: true })
    }
  })

  it('still vetoes when the failure log cannot be written', async () => {
    const blocker = join(await mkdtemp(join(tmpdir(), 'dsh-devflow-blocked-')), 'not-a-directory')
    await writeFile(blocker, 'a file where the log directory would go\n')
    try {
      const { store } = await boot(
        { suite: { exitCode: 1, stderr: 'boom' } },
        {
          edges: { 'developing->reviewing': ['suite'] },
          failureLogDir: join(blocker, 'logs'),
        },
      )
      const result = await review(store)
      expect(result).toMatchObject({ ok: false, code: 'vetoed' })
      const message = (result as { message: string }).message
      // The gate's decision does not depend on the log: the summary still
      // carries what the command printed, and nothing points at a missing file.
      expect(message).toContain('boom')
      expect(message).not.toContain('full output:')
    } finally {
      await rm(blocker, { force: true })
    }
  })

  it('fails the load on a policy naming an invalid edge or a non-positive timeout', async () => {
    await expect(boot({}, { policies: { 'nowhere->done': {} } }))
      .rejects.toThrow('policies names invalid edge "nowhere->done"')
    await expect(boot({}, { policies: { 'developing->reviewing': { timeoutMs: 0 } } }))
      .rejects.toThrow('timeoutMs must be a positive integer')
  })
})
