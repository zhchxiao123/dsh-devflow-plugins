import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AcceptanceProfile } from '../src/config.ts'
import type { StorageState } from '../src/types.ts'

type ServerDouble = { process(): { pid: number | undefined; spawnargs: string[] }; close(): Promise<void> }
const seams = vi.hoisted(() => ({
  spawn: vi.fn<(file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Child>(),
  terminate: vi.fn(), launch: vi.fn<(options: { executablePath?: string }) => Promise<ServerDouble>>(),
  connect: vi.fn(), redact: vi.fn(), artifacts: vi.fn(), verdict: vi.fn(),
}))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: seams.spawn }))
vi.mock('../src/process-tree.ts', () => ({ terminateOwnedTree: seams.terminate }))
vi.mock('playwright', () => ({ chromium: { launchServer: seams.launch, connectOverCDP: seams.connect } }))
vi.mock('../src/official-evidence.ts', () => ({ assertionVerdict: seams.verdict, redactArtifacts: seams.redact, explorationArtifacts: seams.artifacts }))
import { exploreBrowser, invokeOfficial } from '../src/browser.ts'

let dir: string
let p: AcceptanceProfile
let pid: number | undefined
let controller: AbortController
let behavior: (child: Child, args: string[]) => void
class Child extends EventEmitter { pid: number | undefined = 900002; stdout = new EventEmitter(); stderr = new EventEmitter() }
const model = { environment: { MIDSCENE_MODEL_API_KEY: 'secret-value' }, capability: 'unknown' as const,
  redact: (text: string) => text.replaceAll('secret-value', '[REDACTED]') }
beforeEach(async () => {
  vi.resetAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'browser-boundary-'))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  p = { workspace, output: join(dir, 'output'), targetUrl: 'http://localhost:3082', model: 'vision', family: 'gpt-5', baseUrl: 'http://localhost:1234/v1', credentialRef: 'KEY', browserMode: 'puppeteer', timeoutMs: 2000, cleanupTimeoutMs: 100, maxSteps: 5 }
  controller = new AbortController()
  pid = 900001
  await writeFile(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/test\n')
  seams.launch.mockImplementation(async () => ({ process: () => ({ pid, spawnargs: ['--user-data-dir=' + dir] }), close: async () => {} }))
  seams.terminate.mockResolvedValue(undefined)
  seams.redact.mockResolvedValue(undefined)
  seams.artifacts.mockResolvedValue(['exploration.json'])
  seams.verdict.mockResolvedValue(true)
  behavior = (child) => { child.stdout.emit('data', Buffer.from('safe output')); child.stderr.emit('data', Buffer.from('secret-value')); child.emit('close', 0) }
  seams.spawn.mockImplementation((_file: string, args: string[]) => {
    const child = new Child()
    queueMicrotask(() => { behavior(child, args) })
    return child
  })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const run = (request = {}) => exploreBrowser(p, request, model, controller.signal, () => {})

it('observes without declaring acceptance and passes arguments without shell interpolation', async () => {
  const result = await run({ prompt: 'click $(do-not-execute)' })
  expect(result.status).toBe('observed')
  expect(result.output).not.toContain('secret-value')
  expect(seams.spawn.mock.calls.some(call => call[1].includes('click $(do-not-execute)'))).toBe(true)
  expect(seams.spawn.mock.calls[0]?.[2].env.TMPDIR).not.toBe(tmpdir())
  expect(result.workspace).toBe(await realpath(p.workspace))
})

it('keeps borrowed browsers open, serializes each connection, and releases failed leases', async () => {
  p.browserMode = 'cdp'; p.cdpEndpoint = 'ws://localhost:9222/devtools/browser/owned-by-user'
  let unblock: (() => void) | undefined
  behavior = (child) => { unblock = () => child.emit('close', 0) }
  const first = run()
  await vi.waitFor(() =>{  expect(unblock).toBeDefined() })
  expect((await run()).output).toContain('BROWSER_BUSY')
  behavior = child => child.emit('close', 0)
  unblock!()
  expect((await first).cleanup).toBe('confirmed')
  expect(seams.launch).not.toHaveBeenCalled()
  expect(seams.terminate).not.toHaveBeenCalled()
  expect(seams.spawn.mock.calls.at(-1)?.[1]).toContain('disconnect')
  p.browserMode = 'bridge'; delete p.cdpEndpoint
  behavior = (child, args) => child.emit('close', args.includes('disconnect') ? 1 : 0)
  expect((await run()).cleanup).toBe('unknown')
  behavior = child => child.emit('close', 0)
  expect((await run()).cleanup).toBe('confirmed')
})

it('does not turn CLI transport failures or missing structured assertion results into a visual verdict', async () => {
  behavior = (child, args) => child.emit('close', args.includes('assert') ? 1 : 0)
  seams.verdict.mockResolvedValue(false)
  expect((await run({ assertion: 'false' })).status).toBe('assertion-failed')
  seams.verdict.mockResolvedValue(undefined)
  expect((await run({ assertion: 'transport failed' })).status).toBe('infrastructure-error')
  behavior = child => child.emit('close', 0)
  expect((await run({ assertion: 'no task' })).status).toBe('infrastructure-error')
  behavior = child => child.emit('close', 1)
  expect((await run()).status).toBe('infrastructure-error')
})

it('stops on cancellation and reports cleanup failure without claiming passed', async () => {
  behavior = (child) => { controller.abort(); child.emit('close', null) }
  expect((await run()).status).toBe('cancelled')
  expect(seams.terminate).toHaveBeenCalledWith(900002, undefined, 100)
  controller = new AbortController()
  behavior = child => child.emit('close', 0)
  seams.terminate.mockRejectedValue(new Error('cleanup failed'))
  expect((await run({ assertion: 'true' })).cleanup).toBe('unknown')
  seams.terminate.mockResolvedValue(undefined)
  controller.abort()
  expect((await run()).status).toBe('cancelled')
})

it('handles missing process ids, spawn errors and non-Error failures', async () => {
  pid = undefined
  behavior = (child) => { child.pid = undefined; child.emit('error', new Error('spawn failed')) }
  expect((await run()).status).toBe('infrastructure-error')
  seams.launch.mockRejectedValue('unknown failure')
  expect((await run()).output).toBe('Browser execution failed')
})

it('rejects unusable endpoints and observes deadline while waiting for the owned endpoint', async () => {
  seams.launch.mockResolvedValue({ process: () => ({ pid, spawnargs: [] }), close: async () => {} })
  expect((await run()).output).toContain('endpoint unavailable')
  seams.launch.mockImplementation(async () => ({ process: () => ({ pid, spawnargs: ['--user-data-dir=' + dir] }), close: async () => {} }))
  await writeFile(join(dir, 'DevToolsActivePort'), 'broken')
  expect((await run()).output).toContain('Invalid owned CDP')
  await rm(join(dir, 'DevToolsActivePort'))
  p.timeoutMs = 40
  expect((await run()).status).toBe('cancelled')
  await mkdir(join(dir, 'DevToolsActivePort'))
  expect((await run()).status).toBe('infrastructure-error')
})

it('does not expose reports when artifact scrubbing fails and rejects workspace outputs', async () => {
  seams.redact.mockRejectedValue(new Error('unreadable'))
  const result = await run()
  expect(result.artifacts).toEqual([])
  expect(result.output).toContain('REPORT_UNAVAILABLE')
  p.output = p.workspace
  await expect(run()).rejects.toThrow('outside workspace')
})

it('loads only a private target-specific login snapshot and initializes its origin state', async () => {
  p.storageState = join(dir, 'login.json'); p.executablePath = '/test/chrome'
  await writeFile(p.storageState, JSON.stringify({ cookies: [{ name: 'auth', value: 'cookie-secret', domain: 'localhost', path: '/', expires: -1, secure: false, httpOnly: true, sameSite: 'Lax' }], origins: [{ origin: p.targetUrl, localStorage: [{ name: 'session', value: 'local-secret' }] }] }), { mode: 0o600 })
  const setItem = vi.fn()
  vi.stubGlobal('location', { origin: p.targetUrl }); vi.stubGlobal('localStorage', { setItem })
  const page = { goto: vi.fn(), addInitScript: vi.fn(async (fn: (value: StorageState['origins']) => void, value: StorageState['origins']) => { fn(value) }) }
  const context = { addCookies: vi.fn(), newPage: async () => page }
  const close = vi.fn()
  seams.connect.mockResolvedValue({ contexts: () => [context], close })
  behavior = (child) => { child.stdout.emit('data', Buffer.from('cookie-secret local-secret')); child.emit('close', 0) }
  try {
    const result = await run()
    expect(result.output).not.toContain('cookie-secret')
    expect(result.output).not.toContain('local-secret')
    expect(setItem).toHaveBeenCalledWith('session', 'local-secret')
    expect(close).toHaveBeenCalled()
    expect(seams.launch.mock.calls[0]?.[0].executablePath).toBe('/test/chrome')
    vi.stubGlobal('location', { origin: 'http://different.test' })
    expect((await run()).status).toBe('observed')
    await writeFile(p.storageState, JSON.stringify({ cookies: [], origins: [{ origin: p.targetUrl, localStorage: [{ name: 'short', value: '1' }] }] }))
    behavior = (child) => { child.stdout.emit('data', Buffer.from('{"value":"1","count":1}')); child.emit('close', 0) }
    const short = await run()
    expect(short.output).toContain('"value":"[REDACTED]"')
    expect(short.output).toContain('"count":1')
    seams.connect.mockResolvedValue({ contexts: () => [], close })
    expect((await run()).output).toContain('no persistent context')
  } finally { vi.unstubAllGlobals() }
})

it('propagates CLI spawn failure and handles cancellation racing with spawn', async () => {
  seams.spawn.mockImplementation(() => {
    const child = new Child()
    controller.abort()
    queueMicrotask(() => child.emit('close', null))
    return child
  })
  expect((await invokeOfficial(['version'], dir, {}, controller.signal, 100)).code).toBeNull()
  controller = new AbortController()
  seams.terminate.mockRejectedValue(new Error('cleanup denied'))
  await expect(invokeOfficial(['version'], dir, {}, controller.signal, 100)).rejects.toThrow('cleanup denied')
  controller = new AbortController()
  seams.spawn.mockImplementation(() => {
    const child = new Child()
    child.pid = undefined
    controller.abort()
    queueMicrotask(() => child.emit('close', null))
    return child
  })
  expect((await invokeOfficial(['version'], dir, {}, controller.signal, 100)).code).toBeNull()
})
