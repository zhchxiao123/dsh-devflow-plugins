/**
 * The `ShellExecution` a foreground-only double hands back, and nothing more.
 *
 * `ShellExecutor.execute()` resolves a handle that is a live `ShellProcess`
 * plus a memoized `result()`. A plugin that runs a command for its output uses
 * only `result()`: the streaming, spill, signal, and kill members exist for
 * background producers this line has none of. So a double supplies the result
 * and lets every other member fault, which keeps a test honest about which
 * surface it actually exercises instead of inventing stream state nothing reads.
 *
 * The two-call shape (`resolve` then `execute`) replaced the single `run()` when
 * confinement became asynchronous — the executor resolves each policy through
 * its sandbox provider before argv reaches the subprocess seam, so preparation
 * is a promise rather than part of the result.
 * @module tests/shell-execution
 */

import type { ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'

function unreached(member: string): never {
  throw new Error(`shell-execution double: ${member} is not part of the foreground path`)
}

/**
 * Wrap one settled result as the execution handle `execute()` resolves.
 * @param result - what this command's `result()` settles with.
 * @returns a handle whose foreground projection is `result` and whose
 *   background members fault when touched.
 */
export function foregroundExecution(result: ShellRunResult): ShellExecution {
  return {
    result: () => Promise.resolve(result),
    get delta(): string { return unreached('delta') },
    get lossy(): boolean { return unreached('lossy') },
    get status(): never { return unreached('status') },
    exitCode: result.exitCode,
    signal: result.signal,
    get done(): Promise<void> { return unreached('done') },
    get observed(): never { return unreached('observed') },
    readOutput: () => unreached('readOutput'),
    kill: () => unreached('kill'),
  } as unknown as ShellExecution
}
