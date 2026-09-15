import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const doubles = vi.hoisted(() => {
  const exec = vi.fn()
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      exec(...args, (error: Error | null, stdout: string) => {
        if (error) reject(error)
        else resolve({ stdout })
      })
    }),
  })
  return { exec, terminate: vi.fn() }
})
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: doubles.exec }))
vi.mock('../src/process-tree.ts', () => ({ terminateOwnedTree: doubles.terminate }))
import { cleanupOfficialProxy } from '../src/official-proxy.ts'
let root: string
let alive: boolean
const endpoint = 'ws://127.0.0.1:1234/devtools/browser/owned'
const proxy = join(dirname(createRequire(import.meta.url).resolve('@midscene/web')), 'cdp-proxy.js')
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'midscene-proxy-'))
  alive = true
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  doubles.terminate.mockReset().mockImplementation(() => { alive = false; return Promise.resolve() })
  doubles.exec.mockReset().mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => { callback(null, `${process.execPath} ${proxy} ${endpoint}`) })
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
async function pid(value = '34567'): Promise<void> { await writeFile(join(root, 'midscene-cdp-proxy-pid'), value) }
it('uses only private metadata plus matching process identity and confirms the proxy has stopped', async () => {
  await cleanupOfficialProxy(root, endpoint, 1000)
  expect(doubles.terminate).not.toHaveBeenCalled()
  await pid()
  await cleanupOfficialProxy(root, endpoint, 1000)
  expect(doubles.terminate).toHaveBeenCalledWith(34567, undefined, 1000)
  await cleanupOfficialProxy(root, endpoint, 1000)
})
it('rejects malformed, linked, unrelated or still-running processes', async () => {
  for (const value of ['oops', '1', String(process.pid), '9007199254740992', '9999999999999999999999']) {
    await pid(value)
    await expect(cleanupOfficialProxy(root, endpoint, 1000)).rejects.toThrow()
  }
  await rm(join(root, 'midscene-cdp-proxy-pid'))
  await symlink('/does/not/exist', join(root, 'midscene-cdp-proxy-pid'))
  await expect(cleanupOfficialProxy(root, endpoint, 1000)).rejects.toThrow('metadata')
  await rm(join(root, 'midscene-cdp-proxy-pid'))
  await pid()
  doubles.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => { callback(null, 'unrelated node process') })
  await expect(cleanupOfficialProxy(root, endpoint, 1000)).rejects.toThrow('identity mismatch')
  expect(doubles.terminate).not.toHaveBeenCalled()
  doubles.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => { callback(null, `${proxy} ${endpoint}`) })
  doubles.terminate.mockResolvedValue(undefined)
  await expect(cleanupOfficialProxy(root, endpoint, 30)).rejects.toThrow('unconfirmed')
})
it('fails closed on ownership query errors but accepts a process that exited during the query', async () => {
  await pid()
  doubles.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => { callback(new Error('query unavailable')) })
  await expect(cleanupOfficialProxy(root, endpoint, 1000)).rejects.toThrow('ownership unavailable')
  doubles.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => { alive = false; callback(new Error('gone')) })
  await cleanupOfficialProxy(root, endpoint, 1000)
})

it('checks Windows command identity and refuses inaccessible metadata or process ownership', async () => {
  await writeFile(join(root, 'not-a-directory'), 'file')
  await expect(cleanupOfficialProxy(join(root, 'not-a-directory'), endpoint, 1000)).rejects.toThrow('metadata unavailable')
  await pid()
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
  await expect(cleanupOfficialProxy(root, endpoint, 1000)).rejects.toThrow('ownership unavailable')
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  doubles.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => { callback(null, `${proxy} different-endpoint`) })
  await expect(cleanupOfficialProxy(root, endpoint, 1000)).rejects.toThrow('identity mismatch')
  doubles.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => { callback(null, `${proxy} ${endpoint}`) })
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await cleanupOfficialProxy(root, endpoint, 1000)
  expect(doubles.exec.mock.calls.at(-1)?.[0]).toBe('powershell.exe')
})

it('refuses incomplete process identity before any process query', async () => {
  const { terminateCommandMatch } = await import('../src/official-proxy.ts')
  for (const [pid, fragments] of [[1, ['script']], [process.pid, ['script']], [34567, []], [34567, ['']]] as const)
    await expect(terminateCommandMatch(pid, fragments, 1000)).rejects.toThrow('Invalid owned process identity')
  expect(doubles.exec).not.toHaveBeenCalled()
})
