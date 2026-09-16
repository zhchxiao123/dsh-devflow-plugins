/** Explicit orphan cleanup recovers queryable evidence; it never replays browser actions. */
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { readPrivateJson } from './auth-state.ts'
import { within } from './identity.ts'
import { cleanupOfficialProxy, processAlive, terminateCommandMatch } from './official-proxy.ts'
import type { ExplorationOwnership } from './types.ts'

/** Persist only private process ownership facts, outside the published artifact allowlist. */
export async function writeExplorationOwnership(temp: string, record: ExplorationOwnership): Promise<void> {
  const path = join(temp, 'ownership.json')
  await writeFile(path + '.tmp', JSON.stringify(record), { mode: 0o600 })
  await rename(path + '.tmp', path)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery record')
  return value as Record<string, unknown>
}
// Recovery has no model credential context; publish only fixed diagnostic vocabulary.
const cleanupReasons = new Set([
  'No recoverable command ownership', 'No recoverable proxy ownership', 'No recoverable browser ownership',
  'Proxy ownership metadata unavailable', 'Invalid proxy ownership metadata', 'Invalid proxy pid',
  'Invalid owned process identity', 'Proxy process ownership unavailable', 'Proxy process identity mismatch',
  'Proxy cleanup unconfirmed', 'Invalid owned process', 'Invalid termination timeout', 'Process discovery timed out',
  'Process termination failed',
])
function cleanupReason(error: unknown): string {
  const message: unknown = error instanceof Error ? error.message : error
  if (typeof message === 'string' && cleanupReasons.has(message)) return message
  if (error && typeof error === 'object' && 'killed' in error && error.killed === true) return 'Cleanup command timed out or was killed'
  return 'Cleanup failed'
}
/** Called only after profile selection; validates both durable workspace identity and original host death. */
export async function recoverExploration(directory: string, workspace: string, cleanupTimeoutMs: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) throw new Error('Invalid recovery timeout')
  const canonical = await realpath(directory)
  const root = await realpath(workspace)
  if (within(root, canonical) || (await lstat(directory)).isSymbolicLink()) throw new Error('Invalid recovery directory')
  const path = join(canonical, 'exploration.json')
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Invalid recovery record')
  const record = object(JSON.parse(await readFile(path, 'utf8')) as unknown)
  if (record.purpose !== 'exploration' || record.workspace !== root || record.runId !== basename(canonical)
    || !['running', 'interrupted'].includes(String(record.status))) throw new Error('Run is not an interrupted exploration for this workspace')
  const temp = join(canonical, 'tmp')
  if ((await lstat(temp)).isSymbolicLink()) throw new Error('Invalid recovery ownership directory')
  const ownerPath = join(temp, 'ownership.json')
  if ((await lstat(ownerPath)).isSymbolicLink()) throw new Error('Invalid recovery ownership file')
  const owner = object(await readPrivateJson(ownerPath, root))
  if (owner.version !== 1 || !Number.isSafeInteger(owner.ownerPid) || Number(owner.ownerPid) <= 1
    || !['puppeteer', 'cdp', 'bridge'].includes(String(owner.browserMode))) throw new Error('Invalid recovery ownership')
  if (processAlive(Number(owner.ownerPid))) throw new Error('RUN_OWNER_ACTIVE: original host is still alive')
  const failures: { resource: 'command' | 'proxy' | 'browser'; reason: string }[] = []
  const attempt = async (resource: 'command' | 'proxy' | 'browser', operation: Promise<void>): Promise<void> => {
    for (const result of await Promise.allSettled([operation]))
      if (result.status === 'rejected') failures.push({ resource, reason: cleanupReason(result.reason) })
  }
  if (owner.commandPid !== undefined) {
    if (!Number.isSafeInteger(owner.commandPid) || Number(owner.commandPid) <= 1
      || typeof owner.commandScript !== 'string' || !isAbsolute(owner.commandScript)
      || !owner.commandScript.replaceAll('\\', '/').endsWith('/@midscene/web/bin/midscene-web')
      || typeof owner.endpoint !== 'string' || !owner.endpoint || owner.browserMode === 'bridge') {
      failures.push({ resource: 'command', reason: 'No recoverable command ownership' })
    } else await attempt('command', terminateCommandMatch(Number(owner.commandPid), [owner.commandScript, owner.endpoint], cleanupTimeoutMs))
  }
  if (typeof owner.endpoint === 'string' && owner.endpoint) {
    await attempt('proxy', cleanupOfficialProxy(temp, owner.endpoint, cleanupTimeoutMs))
  } else if (owner.browserMode !== 'puppeteer') failures.push({ resource: 'proxy', reason: 'No recoverable proxy ownership' })
  if (owner.browserMode === 'puppeteer') {
    if (!Number.isSafeInteger(owner.browserPid) || Number(owner.browserPid) <= 1
      || typeof owner.browserExecutable !== 'string' || !isAbsolute(owner.browserExecutable)
      || typeof owner.browserUserDataDir !== 'string' || !isAbsolute(owner.browserUserDataDir)) {
      failures.push({ resource: 'browser', reason: 'No recoverable browser ownership' })
    } else await attempt('browser', terminateCommandMatch(Number(owner.browserPid), [owner.browserExecutable, '--user-data-dir=' + owner.browserUserDataDir], cleanupTimeoutMs))
  }
  const recovered = { ...record, status: 'interrupted', cleanup: failures.length ? 'unknown' : 'confirmed', cleanupFailures: failures, recoveredAt: new Date().toISOString() }
  await writeFile(path + '.tmp', JSON.stringify(recovered, null, 2) + '\n', { mode: 0o600 })
  await rename(path + '.tmp', path)
  return recovered
}
