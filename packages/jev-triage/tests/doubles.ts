// Doubles for the two things this tool reaches outside itself: the judgement
// seam and the shell.
//
// The judgement double is an in-memory `JevRuntime` — no provider package is
// imported anywhere in this directory, which is what makes "the backend is
// swappable" something the suite checks rather than something it assumes.
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { foregroundExecution } from '../../../tests/shell-execution.ts'
import JevRuntime, { JevError } from '@zhchxiao123/dsh-jev'
import type { Answer, JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'

/** What a {@link MemoryJev} should do when asked. */
export type JevScript = JevResponse | JevError

/** In-memory judgement: no network, no credentials, fully scripted. */
export class MemoryJev extends JevRuntime {
  /** Every request that reached the transport, in order. */
  readonly calls: JevRequest[] = []

  private script: JevScript = { answers: {} }

  /** Replace what the next judgement returns, or throws. */
  setScript(script: JevScript): void {
    this.script = script
  }

  protected override async perform(request: JevRequest): Promise<JevResponse> {
    this.calls.push(request)
    if (this.script instanceof JevError) throw this.script
    return await Promise.resolve(this.script)
  }
}

/** A score answer, at the confidence a spec wants to test around. */
export function scoreAnswer(score: number, confidence: number): Answer {
  return { type: 'score', score, confidence, probabilities: [] }
}

/** What a {@link ScriptedShell} run should look like. */
export interface ShellOutcome {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number | null
  readonly truncated?: boolean
  readonly timedOut?: boolean
  readonly aborted?: boolean
  /** Set to make `run` reject, standing in for an executor infrastructure fault. */
  readonly throws?: Error
}

/**
 * A shell that returns what a spec tells it to.
 *
 * The base `ShellExecutor` satisfies `inject: ['shell']` and nothing else —
 * calling `resolve()` on it throws — so a suite that never runs a real command
 * still needs a subclass rather than the base class.
 */
export class ScriptedShell extends ShellExecutor {
  /** Every command string this was handed, in order. */
  readonly commands: string[] = []

  private outcome: ShellOutcome = { stdout: '' }

  /** Replace what the next run does. */
  setOutcome(outcome: ShellOutcome): void {
    this.outcome = outcome
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    this.commands.push(request.command)
    return {
      ...request,
      workdir: request.workdir ?? '/repo',
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
      sandboxPolicy: undefined,
    }
  }

  override execute(spec: ShellExecSpec): Promise<ShellExecution> {
    if (this.outcome.throws !== undefined) return Promise.reject(this.outcome.throws)
    return Promise.resolve(foregroundExecution({
      exitCode: this.outcome.exitCode ?? 0,
      signal: null,
      timedOut: this.outcome.timedOut ?? false,
      aborted: this.outcome.aborted ?? false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: this.outcome.stdout ?? '', truncated: this.outcome.truncated ?? false },
      stderr: { text: this.outcome.stderr ?? '', truncated: false },
    }))
  }
}

/** A one-file unified diff, for specs that only care about the file list. */
export function textDiff(path: string, body = '+added line'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 0000000..1111111 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    body,
  ].join('\n')
}
