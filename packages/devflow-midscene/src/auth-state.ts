/** Login snapshots cross a private file/IPC boundary and are restricted to the declared target. */
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { within } from './identity.ts'
import type { StorageState } from './types.ts'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid login snapshot')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid login snapshot')
  return value
}
/** Reject unrelated cookies/origins rather than copying a user's whole browser profile. */
export function parseStorageState(value: unknown, baseUrl: string): StorageState {
  const state = object(value)
  const target = new URL(baseUrl)
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('Invalid login snapshot')
  return {
    cookies: state.cookies.map((value) => {
      const cookie = object(value)
      const domain = string(cookie.domain)
      const host = domain.replace(/^\./, '')
      if (target.hostname !== host && !(domain.startsWith('.') && target.hostname.endsWith('.' + host))) throw new Error('Login snapshot target mismatch')
      if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires) || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean' || !['Strict', 'Lax', 'None'].includes(String(cookie.sameSite))) throw new Error('Invalid login snapshot')
      return { name: string(cookie.name), value: string(cookie.value), domain, path: string(cookie.path), expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None' }
    }),
    origins: state.origins.map((value) => {
      const origin = object(value)
      if (origin.origin !== target.origin || !Array.isArray(origin.localStorage)) throw new Error('Login snapshot target mismatch')
      return { origin: target.origin, localStorage: origin.localStorage.map((value) => {
        const entry = object(value)
        return { name: string(entry.name), value: string(entry.value) }
      }) }
    }),
  }
}
/** Open once without following a final symlink; permissions and size are checked on the same handle. */
export async function readPrivateJson(path: string, workspace: string): Promise<unknown> {
  const canonical = await realpath(path)
  if (within(workspace, canonical)) throw new Error('Private acceptance input must be outside workspace')
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 1024 * 1024 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error('Private acceptance input requires owner-only access')
    return JSON.parse(await file.readFile('utf8')) as unknown
  } finally {
    await file.close()
  }
}
