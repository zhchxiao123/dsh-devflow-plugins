/** Midscene 1.12.6 starts a detached CDP proxy even when Chromium is borrowed. */
import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { terminateOwnedTree } from './process-tree.ts'
const exec = promisify(execFile)
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false
    throw new Error('Proxy process ownership unavailable')
  }
}
/** Private SDK PID metadata is accepted only while the process command still matches this proxy and endpoint. */
export async function cleanupOfficialProxy(temp: string, endpoint: string, timeoutMs: number): Promise<void> {
  const file = join(temp, 'midscene-cdp-proxy-pid')
  let info: Awaited<ReturnType<typeof lstat>>
  try { info = await lstat(file) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      // Windows also reports ENOENT when a parent is a file, which is invalid ownership metadata.
      const parent = await lstat(temp).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
        throw new Error('Proxy ownership metadata unavailable')
      })
      if (parent && !parent.isDirectory()) throw new Error('Proxy ownership metadata unavailable')
      return
    }
    throw new Error('Proxy ownership metadata unavailable')
  }
  if (!info.isFile() || info.size > 16) throw new Error('Invalid proxy ownership metadata')
  const value = (await readFile(file, 'utf8')).trim()
  const pid = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Invalid proxy pid')
  const proxy = join(dirname(createRequire(import.meta.url).resolve('@midscene/web')), 'cdp-proxy.js')
  await terminateCommandMatch(pid, [proxy, endpoint], timeoutMs)
}
/** Verify a recorded process command before terminating an orphaned run-owned resource. */
export async function terminateCommandMatch(pid: number, fragments: readonly string[], timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !fragments.length || fragments.some(value => !value)) throw new Error('Invalid owned process identity')
  const deadline = Date.now() + timeoutMs
  if (!processAlive(pid)) return
  let command: string
  try {
    const result = process.platform === 'win32'
      ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { timeout: timeoutMs })
      : await exec('ps', ['-p', String(pid), '-o', 'command='], { timeout: timeoutMs })
    command = result.stdout
  } catch {
    if (!processAlive(pid)) return
    throw new Error('Proxy process ownership unavailable')
  }
  if (!fragments.every(fragment => command.includes(fragment))) {
    // A successful CIM query can return no command when the process exits during inspection.
    if (!processAlive(pid)) return
    throw new Error('Proxy process identity mismatch')
  }
  await terminateOwnedTree(pid, undefined, timeoutMs)
  while (processAlive(pid) && Date.now() < deadline) await delay(Math.min(20, deadline - Date.now()))
  if (processAlive(pid)) throw new Error('Proxy cleanup unconfirmed')
}
