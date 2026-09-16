/** Check the published links a copied card artifact actually exposes. */
import { realpath, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every link must resolve to this run's local file, or answer a bounded HTTP request with matching bytes. */
export async function publicationAvailable(
  dir: string,
  base: unknown,
  paths: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (typeof base !== 'string') return false
  try {
    const url = new URL(base)
    if (url.username || url.password || url.search || url.hash) return false
    const deadline = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    requestSignal.throwIfAborted()
    for (const path of paths) {
      requestSignal.throwIfAborted()
      const target = new URL(path, url)
      if (target.protocol === 'file:') {
        const actual = await realpath(fileURLToPath(target))
        if (actual !== (await realpath(join(dir, path))) || (await stat(actual)).size === 0) return false
      } else if (target.protocol === 'http:' || target.protocol === 'https:') {
        const response = await fetch(target, {
          method: 'GET',
          redirect: 'error',
          signal: requestSignal,
        })
        if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(await readFile(join(dir, path))))
          return false
      } else return false
    }
    requestSignal.throwIfAborted()
    return true
  } catch {
    return false
  }
}
