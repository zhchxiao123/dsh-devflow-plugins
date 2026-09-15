/** Terminate a runner-owned process tree, including Chromium's detached process groups. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
function signal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}
/** Stop spawning before discovery; even a failed discovery kills every known owned PID. */
export async function terminateOwnedTree(rootPid: number, browserPid?: number, timeoutMs = 5000): Promise<void> {
  for (const pid of [rootPid, ...(browserPid === undefined ? [] : [browserPid])]) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Invalid owned process')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid termination timeout')
  if (process.platform === 'win32') {
    // The worker may already have exited; its separately recorded browser tree still needs termination.
    const outcomes = await Promise.allSettled(
      [...new Set([rootPid, ...(browserPid === undefined ? [] : [browserPid])])].map(pid =>
        exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: timeoutMs, killSignal: 'SIGKILL' }),
      ),
    )
    const failed = outcomes.find(outcome => outcome.status === 'rejected')
    if (failed?.status === 'rejected')
      throw failed.reason instanceof Error ? failed.reason : new Error('Process termination failed')
    return
  }
  const owned = new Set<number>([rootPid, ...(browserPid === undefined ? [] : [browserPid])])
  const deadline = Date.now() + timeoutMs
  try {
    for (const pid of owned) signal(pid, 'SIGSTOP')
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Process discovery timed out')
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid='], { timeout: remaining, killSignal: 'SIGKILL' })
      let discovered = false
      for (const row of stdout.trim().split('\n')) {
        const [pid, parent] = row.trim().split(/\s+/).map(Number)
        if (pid && pid !== process.pid && parent && owned.has(parent) && !owned.has(pid)) {
          owned.add(pid)
          signal(pid, 'SIGSTOP')
          discovered = true
        }
      }
      if (!discovered) break
    }
  } finally {
    let failure: unknown
    for (const pid of [...owned].reverse()) {
      try {
        signal(pid, 'SIGKILL')
      } catch (error) {
        failure = error
      }
    }
    if (failure) throw failure instanceof Error ? failure : new Error('Process termination failed')
  }
}
