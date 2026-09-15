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
  const outcomes: PromiseSettledResult<void>[] = []
  if (owner.commandPid !== undefined) {
    if (!Number.isSafeInteger(owner.commandPid) || Number(owner.commandPid) <= 1
      || typeof owner.commandScript !== 'string' || !isAbsolute(owner.commandScript)
      || !owner.commandScript.replaceAll('\\', '/').endsWith('/@midscene/web/bin/midscene-web')
      || typeof owner.endpoint !== 'string' || !owner.endpoint || owner.browserMode === 'bridge') {
      outcomes.push({ status: 'rejected', reason: 'No recoverable command ownership' })
    } else outcomes.push(...await Promise.allSettled([
      terminateCommandMatch(Number(owner.commandPid), [owner.commandScript, owner.endpoint], cleanupTimeoutMs),
    ]))
  }
  if (typeof owner.endpoint === 'string' && owner.endpoint) {
    outcomes.push(...await Promise.allSettled([cleanupOfficialProxy(temp, owner.endpoint, cleanupTimeoutMs)]))
  } else if (owner.browserMode !== 'puppeteer') outcomes.push({ status: 'rejected', reason: 'No recoverable proxy ownership' })
  if (owner.browserMode === 'puppeteer') {
    if (!Number.isSafeInteger(owner.browserPid) || Number(owner.browserPid) <= 1
      || typeof owner.browserExecutable !== 'string' || !isAbsolute(owner.browserExecutable)
      || typeof owner.browserUserDataDir !== 'string' || !isAbsolute(owner.browserUserDataDir)) {
      outcomes.push({ status: 'rejected', reason: 'No recoverable browser ownership' })
    } else outcomes.push(...await Promise.allSettled([
      terminateCommandMatch(Number(owner.browserPid), [owner.browserExecutable, '--user-data-dir=' + owner.browserUserDataDir], cleanupTimeoutMs),
    ]))
  }
  const recovered = { ...record, status: 'interrupted', cleanup: outcomes.some(result => result.status === 'rejected') ? 'unknown' : 'confirmed', recoveredAt: new Date().toISOString() }
  await writeFile(path + '.tmp', JSON.stringify(recovered, null, 2) + '\n', { mode: 0o600 })
  await rename(path + '.tmp', path)
  return recovered
}
