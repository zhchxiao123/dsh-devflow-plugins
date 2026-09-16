/** Project login snapshots stay private and are scoped to an origin and test role. */
import { lstat, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseStorageState, readPrivateJson } from './auth-state.ts'
import { sha256 } from './identity.ts'

export function loginPath(output: string, targetUrl: string, role: string): string {
  return join(output, `login-${sha256(JSON.stringify([new URL(targetUrl).origin, role]))}.json`)
}
/** Missing and invalid snapshots never count as authenticated readiness. */
export async function loginStatus(path: string, workspace: string, targetUrl: string): Promise<'missing' | 'invalid' | 'available'> {
  try { if (!(await lstat(path)).isFile()) return 'invalid' } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'
    return 'invalid'
  }
  try {
    const state = parseStorageState(await readPrivateJson(path, workspace), targetUrl)
    if (!state.cookies.some(cookie => cookie.expires === -1 || cookie.expires > Date.now() / 1000)
      && !state.origins.some(origin => origin.localStorage.length > 0)) return 'invalid'
    return 'available'
  } catch { return 'invalid' }
}
/** Normalize the authorized target snapshot; never return cookie or localStorage values. */
export async function importLogin(source: string, destination: string, workspace: string, targetUrl: string): Promise<void> {
  const state = await (async () => {
    try { return parseStorageState(await readPrivateJson(source, workspace), targetUrl) }
    catch { throw new Error('MIDSCENE_LOGIN_INVALID: use an owner-only, target-scoped snapshot outside the workspace') }
  })()
  const temp = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
    if (await loginStatus(temp, workspace, targetUrl) !== 'available') throw new Error('MIDSCENE_LOGIN_INVALID: provide a fresh target-scoped login snapshot')
    await rename(temp, destination)
  } finally { await rm(temp, { force: true }) }
}
