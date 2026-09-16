import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const boundary = vi.hoisted(() => ({ alive: vi.fn(), proxy: vi.fn(), browser: vi.fn() }))
vi.mock('../src/official-proxy.ts', () => ({ processAlive: boundary.alive, cleanupOfficialProxy: boundary.proxy, terminateCommandMatch: boundary.browser }))
import { recoverExploration, writeExplorationOwnership } from '../src/recovery.ts'
let root: string
let workspace: string
let run: string
const runId = '00000000-0000-4000-8000-000000000001'
let record: Record<string, unknown>
let owner: Record<string, unknown>
async function persistOwner(): Promise<void> { await writeFile(join(run, 'tmp', 'ownership.json'), JSON.stringify(owner), { mode: 0o600 }) }
async function persistRecord(): Promise<void> { await writeFile(join(run, 'exploration.json'), JSON.stringify(record), { mode: 0o600 }) }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'midscene-recover-')))
  workspace = join(root, 'workspace'); run = join(root, 'output', runId)
  await mkdir(workspace); await mkdir(join(run, 'tmp'), { recursive: true })
  record = { purpose: 'exploration', status: 'running', runId, workspace, artifacts: [] }
  owner = { version: 1, ownerPid: 34567, browserMode: 'cdp', endpoint: 'ws://127.0.0.1:1234/devtools/browser/fixture' }
  await persistRecord(); await persistOwner()
  boundary.alive.mockReset().mockReturnValue(false)
  boundary.proxy.mockReset().mockResolvedValue(undefined)
  boundary.browser.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('recovers only an orphaned borrowed proxy and persists interrupted evidence without replay', async () => {
  const result = await recoverExploration(run, workspace, 100)
  expect(result).toMatchObject({ status: 'interrupted', cleanup: 'confirmed', runId })
  expect(boundary.proxy).toHaveBeenCalledWith(join(run, 'tmp'), owner.endpoint, 100)
  expect(boundary.browser).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(join(run, 'exploration.json'), 'utf8')) as unknown).toMatchObject({ status: 'interrupted' })
  await recoverExploration(run, workspace, 100)
})
it('refuses live original hosts and unrelated or malformed durable identities', async () => {
  boundary.alive.mockReturnValue(true)
  await expect(recoverExploration(run, workspace, 100)).rejects.toThrow('RUN_OWNER_ACTIVE')
  expect(boundary.proxy).not.toHaveBeenCalled()
  boundary.alive.mockReturnValue(false)
  const original = record
  for (const value of [null, [], { ...original, purpose: 'other' }, { ...original, workspace: root }, { ...original, runId: 'other' }, { ...original, status: 'passed' }]) {
    await writeFile(join(run, 'exploration.json'), JSON.stringify(value))
    await expect(recoverExploration(run, workspace, 100)).rejects.toThrow()
  }
  await persistRecord()
  for (const invalid of [{ ...owner, version: 2 }, { ...owner, ownerPid: 'id' }, { ...owner, ownerPid: 1 }, { ...owner, browserMode: 'unknown' }]) {
    await writeFile(join(run, 'tmp', 'ownership.json'), JSON.stringify(invalid))
    await expect(recoverExploration(run, workspace, 100)).rejects.toThrow('ownership')
  }
})
it('independently releases a recorded owned browser after proxy failure and reports uncertain cleanup', async () => {
  owner = { ...owner, browserMode: 'puppeteer', browserPid: 34568, browserExecutable: '/browser/chrome', browserUserDataDir: '/private/browser-profile' }
  await persistOwner()
  boundary.proxy.mockRejectedValue(new Error('ownership cannot be confirmed'))
  expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'unknown' })
  expect(boundary.browser).toHaveBeenCalledWith(34568, ['/browser/chrome', '--user-data-dir=/private/browser-profile'], 100)
  boundary.proxy.mockResolvedValue(undefined)
  expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'confirmed' })
  owner = { version: 1, ownerPid: 34567, browserMode: 'puppeteer' }
  await persistOwner()
  expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'unknown' })
  owner = { version: 1, ownerPid: 34567, browserMode: 'bridge' }
  await persistOwner()
  expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'unknown' })
})
it('requires external real directories and finite cleanup limits and writes private ownership atomically', async () => {
  for (const timeout of [0, NaN]) await expect(recoverExploration(run, workspace, timeout)).rejects.toThrow('timeout')
  await expect(recoverExploration(run, root, 100)).rejects.toThrow('directory')
  await symlink(run, join(root, 'link'))
  await expect(recoverExploration(join(root, 'link'), workspace, 100)).rejects.toThrow('directory')
  await rm(join(run, 'exploration.json'))
  await symlink(join(run, 'tmp', 'ownership.json'), join(run, 'exploration.json'))
  await expect(recoverExploration(run, workspace, 100)).rejects.toThrow('record')
  await rm(join(run, 'exploration.json'))
  await persistRecord()
  await rm(join(run, 'tmp'), { recursive: true })
  await symlink(workspace, join(run, 'tmp'))
  await expect(recoverExploration(run, workspace, 100)).rejects.toThrow('ownership directory')
  await rm(join(run, 'tmp'))
  await mkdir(join(run, 'tmp'))
  await writeExplorationOwnership(join(run, 'tmp'), { version: 1, ownerPid: 34567, browserMode: 'bridge' })
  expect(JSON.parse(await readFile(join(run, 'tmp', 'ownership.json'), 'utf8')) as unknown).toMatchObject({ ownerPid: 34567 })
})

it('cleans an orphaned official command before its proxy and refuses forged command metadata', async () => {
  owner = { ...owner, commandPid: 34569, commandScript: '/opt/node_modules/@midscene/web/bin/midscene-web' }
  await persistOwner()
  expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'confirmed' })
  expect(boundary.browser).toHaveBeenCalledWith(34569, ['/opt/node_modules/@midscene/web/bin/midscene-web', owner.endpoint], 100)
  expect(boundary.browser.mock.invocationCallOrder[0]).toBeLessThan(boundary.proxy.mock.invocationCallOrder[0] ?? Infinity)
  for (const invalid of [{ ...owner, commandPid: 'pid' }, { ...owner, commandPid: 1 }, { ...owner, commandScript: undefined }, { ...owner, commandScript: 'relative' }, { ...owner, commandScript: '/other/script.js' }, { ...owner, endpoint: undefined }, { ...owner, endpoint: '' }, { ...owner, browserMode: 'bridge' }]) {
    await writeFile(join(run, 'tmp', 'ownership.json'), JSON.stringify(invalid))
    expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'unknown' })
  }
})

it('rejects an ownership-file symlink before consulting process identity', async () => {
  await rm(join(run, 'tmp', 'ownership.json'))
  await symlink(join(run, 'exploration.json'), join(run, 'tmp', 'ownership.json'))
  await expect(recoverExploration(run, workspace, 100)).rejects.toThrow('ownership file')
  expect(boundary.alive).not.toHaveBeenCalled()
})

it.each([
  [new Error('Proxy process identity mismatch'), 'Proxy process identity mismatch'],
  ['Proxy cleanup unconfirmed', 'Proxy cleanup unconfirmed'],
  [Object.assign(new Error('secret-token'), { killed: true }), 'Cleanup command timed out or was killed'],
  [Object.assign(new Error('secret-token'), { killed: false }), 'Cleanup failed'],
  [new Error('secret-token'), 'Cleanup failed'],
  [null, 'Cleanup failed'],
])('records the failed cleanup stage without publishing arbitrary rejection content', async (error, reason) => {
  boundary.proxy.mockRejectedValueOnce(error)
  const result = await recoverExploration(run, workspace, 100)
  expect(result).toMatchObject({ cleanup: 'unknown', cleanupFailures: [{ resource: 'proxy', reason }] })
  const durable = await readFile(join(run, 'exploration.json'), 'utf8')
  expect(JSON.parse(durable) as unknown).toMatchObject({ cleanupFailures: [{ resource: 'proxy', reason }] })
  expect(durable).not.toContain('secret-token')
  expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'confirmed', cleanupFailures: [] })
})

it('retains each failed resource and still attempts the owned browser after earlier failures', async () => {
  owner = { ...owner, browserMode: 'puppeteer', commandPid: 34569, commandScript: '/opt/node_modules/@midscene/web/bin/midscene-web', browserPid: 34568, browserExecutable: '/browser/chrome', browserUserDataDir: '/private/browser-profile' }
  await persistOwner()
  boundary.browser.mockRejectedValueOnce(new Error('Proxy process ownership unavailable')).mockRejectedValueOnce(new Error('Proxy cleanup unconfirmed'))
  boundary.proxy.mockRejectedValueOnce(new Error('Proxy ownership metadata unavailable'))
  expect(await recoverExploration(run, workspace, 100)).toMatchObject({ cleanup: 'unknown', cleanupFailures: [
    { resource: 'command', reason: 'Proxy process ownership unavailable' },
    { resource: 'proxy', reason: 'Proxy ownership metadata unavailable' },
    { resource: 'browser', reason: 'Proxy cleanup unconfirmed' },
  ] })
  expect(boundary.browser).toHaveBeenCalledTimes(2)
})
