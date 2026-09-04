/**
 * The execution context handed to a driver for one tool call. Drivers reach
 * the outside world only through this, so the core keeps ownership of every
 * deadline, of the bounded output tail, and of which phase a failure belongs
 * to — and a driver stays drivable from a test without the service it deploys.
 *
 * Phase durations are `performance.now()` differences. Release identifiers are
 * the one deliberate wall-clock reading: they are durable, sortable names, not
 * measurements.
 */

import { resolve } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { DeployRun, ExecOptions, ExecResult, Phase, PhaseTiming } from './types.ts'

/** In-memory tail cap per captured stream, applied to both collected streams. */
export interface RunSettings {
  readonly root: string
  readonly remoteTimeoutMs: number
  readonly logTailBytes: number
  readonly graceMs: number
  /** Wall clock behind {@link DeployRun.releaseId}; injected so tests pin the identifier. */
  readonly clock: () => Date
}

/** What the run needs from the plugin context. */
export interface RunHost {
  readonly subprocess: SubprocessRuntime
}

/**
 * Wrap one manifest command for the shell. `exec 2>&1` merges stderr into the
 * collected stdout stream, so a single offset covers the whole command log.
 */
export function shellArgv(command: string): readonly string[] {
  return ['sh', '-c', `exec 2>&1\n${command}`]
}

/** A deploy, rollback, or status call that failed, attributed to the phase it failed in. */
export class DeployFailure extends Error {
  readonly phase: Phase
  /** Exit facts of the command that failed; absent when the phase failed before running one. */
  readonly result?: ExecResult

  constructor(phase: Phase, summary: string, result?: ExecResult) {
    super(result === undefined ? `${phase}: ${summary}` : `${phase}: ${summary}\n${describe(result)}`)
    this.name = 'DeployFailure'
    this.phase = phase
    if (result !== undefined) this.result = result
  }
}

function exitFacts(outcome: SubprocessOutcome): string {
  if (outcome.exitCode !== null) return `exit code ${outcome.exitCode}`
  /* v8 ignore next -- Node's close event reports a signal whenever the exit code is null. */
  return `killed by ${outcome.signal ?? 'a signal'}`
}

/** The failure detail a model reads: the command as run, how it ended, and its output tail. */
function describe(result: ExecResult): string {
  const ending = result.timedOut
    ? `timed out after ${result.durationMs}ms and its process tree was terminated`
    : exitFacts(result)
  const head = `  command: ${result.argv.join(' ')}\n  ended: ${ending}`
  return result.output === '' ? head : `${head}\n  output:\n${indent(result.output.trimEnd())}`
}

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n')
}

function readAll(reader: SubprocessOutputReader | undefined): string {
  /* v8 ignore next -- every spawn here requests collect mode on both streams. */
  return reader?.readFrom(0).text ?? ''
}

function tailOf(handle: SubprocessHandle): string {
  const out = readAll(handle.collected.stdout)
  const err = readAll(handle.collected.stderr)
  return err === '' ? out : `${out}--- stderr ---\n${err}`
}

function message(error: unknown): string {
  /* v8 ignore next -- the subprocess seam rejects with Error; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}

/** Whole milliseconds elapsed since a `performance.now()` mark — monotonic, never wall-clock. */
function since(start: number): number {
  return Math.round(performance.now() - start)
}

/** `YYYYMMDDTHHMMSSZ` — sortable as text, and legible in a directory listing or an image tag. */
function formatReleaseId(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}Z`
}

/** One tool call's run, plus the timeline and warnings the report projects. */
export class DeployRunContext implements DeployRun {
  readonly root: string
  private readonly host: RunHost
  private readonly settings: RunSettings
  private readonly timings: PhaseTiming[] = []
  private readonly warnings: string[] = []
  private current: Phase = 'resolve'
  private currentStartedAt = performance.now()

  constructor(host: RunHost, settings: RunSettings) {
    this.host = host
    this.settings = settings
    this.root = settings.root
  }

  /** The phase a failure raised right now belongs to. */
  get activePhase(): Phase {
    return this.current
  }

  phase(phase: Phase): void {
    if (phase === this.current) return
    this.timings.push({ phase: this.current, durationMs: since(this.currentStartedAt) })
    this.current = phase
    this.currentStartedAt = performance.now()
  }

  /** The phase timeline, closing the phase still open. */
  timeline(): readonly PhaseTiming[] {
    return [...this.timings, { phase: this.current, durationMs: since(this.currentStartedAt) }]
  }

  /** Non-fatal defects recorded during the run, in the order they were found. */
  recordedWarnings(): readonly string[] {
    return [...this.warnings]
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  releaseId(): string {
    return formatReleaseId(this.settings.clock())
  }

  /**
   * Run one command to completion under a deadline. A non-zero exit is a
   * result, not a throw — the caller decides whether it ends the run.
   *
   * No explicit `env` is supplied, so the child gets the seam's scrubbed
   * parent base. That is load-bearing rather than incidental: this package
   * holds no credentials and relies on the harness machine's own SSH
   * authentication, which reaches the child through `SSH_AUTH_SOCK`. That name
   * survives the scrub because the pattern removes `KEY|PASSWORD|SECRET|TOKEN`;
   * widening it to cover `SOCK` or `AUTH` would break every remote command
   * here, which is why a test pins the forwarding.
   */
  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? this.settings.remoteTimeoutMs
    const deadline = AbortSignal.timeout(timeoutMs)
    const maxBytes = this.settings.logTailBytes
    const startedAt = performance.now()
    let handle: SubprocessHandle
    try {
      handle = this.host.subprocess.spawn({
        argv,
        cwd: resolve(this.settings.root, options.cwd ?? '.'),
        stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } },
        graceMs: this.settings.graceMs,
        signal: deadline,
      })
    } catch (error) {
      throw new DeployFailure(this.current, `could not spawn ${argv[0] ?? '(no command)'}: ${message(error)}`)
    }
    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new DeployFailure(this.current, `${argv.join(' ')} could not be run: ${message(error)}`)
    }
    return {
      argv,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      output: tailOf(handle),
      ok: outcome.exitCode === 0,
      timedOut: deadline.aborted,
      durationMs: since(startedAt),
    }
  }

  async mustExec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    const result = await this.exec(argv, options)
    if (!result.ok) throw new DeployFailure(this.current, 'a command failed', result)
    return result
  }
}
