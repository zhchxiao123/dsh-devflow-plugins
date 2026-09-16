import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProject } from '../src/project.ts'
import { parseProjectSettings, projectRelativePath, projectTargetUrl, readProjectFile, readSettings, writeSettings, writeProjectFile, withProjectMutation } from '../src/project-settings.ts'
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root(): Promise<string> { const path = await fs.realpath(await mkdtemp(join(tmpdir(), 'midscene-project-'))); roots.push(path); return path }
async function file(root: string, path: string, value: unknown): Promise<void> {
  const target = join(root, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value))
}
it('keeps settings absent until a choice is saved, validates and atomically replaces choices', async () => {
  const dir = await root()
  expect(await readSettings(dir)).toEqual({})
  const settings = { app: 'apps/web', targetUrl: 'http://localhost:3000/', model: { provider: 'local', model: 'vision', family: 'qwen3-vl' }, suites: { '0001-web': { suite: 'e2e/acceptance.json', suiteSha256: 'a'.repeat(64), buildId: 'build-1' } } }
  await writeSettings(dir, settings)
  expect(await readSettings(dir)).toEqual(settings)
  await writeSettings(dir, { model: { provider: 'local', model: 'vision' } })
  expect(await readSettings(dir)).toEqual({ model: { provider: 'local', model: 'vision' } })
  expect(await readdir(join(dir, '.devflow/midscene'))).toEqual(['settings.json'])
})
it.each([null, [], false, { unknown: 1 }, { model: { provider: 'p', model: 'm', apiKey: 'secret' } }, { app: '' }, { app: 4 }, { app: 'a\nb' }, { app: 'a'.repeat(2049) }, { app: '../escape' }, { app: '/absolute' }, { app: 'a/./b' }, { suites: { nope: {} } }, { suites: { '1-a': { suite: 'suite.json', suiteSha256: 'no', buildId: 'b' } } }])('rejects malformed or nonportable settings %j', (value) => {
  expect(() => parseProjectSettings(value)).toThrow()
})
it.each(['file:///tmp/a', 'http://u:p@localhost', 'http://localhost/?key=x', 'http://localhost/#fragment'])('rejects unsafe URL %s', (value) => { expect(() => projectTargetUrl(value)).toThrow() })
it('accepts dot and portable nested paths', () => { expect(projectRelativePath('.')).toBe('.'); expect(projectRelativePath('apps/my web')).toBe('apps/my web') })
it('rejects malformed JSON and oversized or nonregular repository input', async () => {
  const dir = await root()
  await file(dir, '.devflow/midscene/settings.json', '{')
  await expect(readSettings(dir)).rejects.toThrow()
  await file(dir, 'large', 'a'.repeat(262145))
  await expect(readProjectFile(dir, 'large')).rejects.toThrow('bounded')
  await expect(readProjectFile(dir, '.devflow')).rejects.toThrow('bounded')
})
it('rejects symlinks in settings and discovery inputs without changing outside files', async () => {
  const dir = await root(); const outside = await root()
  await symlink(outside, join(dir, '.devflow'), 'junction')
  await expect(writeSettings(dir, {})).rejects.toThrow('symbolic links')
  await expect(readSettings(dir)).rejects.toThrow('symbolic links')
  expect(await readdir(outside)).toEqual([])
})
it('cleans a temporary settings file after failed publication', async () => {
  const dir = await root()
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk failure'))
  await expect(writeSettings(dir, {})).rejects.toThrow('disk failure')
  expect(await readdir(join(dir, '.devflow/midscene'))).toEqual([])
})
it('refuses oversized settings', async () => {
  const dir = await root()
  const suites = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`${i}-a`, { suite: 'a', suiteSha256: 'a'.repeat(64), buildId: 'b'.repeat(2048) }]))
  await expect(writeSettings(dir, { suites })).rejects.toThrow('size limit')
})
it('propagates filesystem errors', async () => {
  const dir = await root()
  vi.spyOn(fs, 'lstat').mockRejectedValueOnce(new Error('denied'))
  await expect(readSettings(dir)).rejects.toThrow('denied')
  vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('denied'))
  await expect(readSettings(dir)).rejects.toThrow('denied')
})
it('bounds a file that grows after stat', async () => {
  const dir = await root(); await file(dir, 'input', '')
  const original = fs.open
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await original(...args)
    const stat = handle.stat.bind(handle)
    vi.spyOn(handle, 'stat').mockImplementationOnce(async () => { const before = await stat(); await file(dir, 'input', 'a'.repeat(262145)); return before })
    return handle
  })
  await expect(readProjectFile(dir, 'input')).rejects.toThrow('size limit')
})
it('never guesses a default framework port or executes configuration', async () => {
  const dir = await root()
  await file(dir, 'package.json', { scripts: { dev: 'vite', test: 'echo test', serve: 42, start: 'unknown --port 1234' } })
  expect(await discoverProject(dir)).toMatchObject({ status: 'unavailable', targets: [], apps: [{ path: '.', scripts: { dev: 'vite', start: 'unknown --port 1234' } }] })
})
it('discovers explicit script ports and reports competing applications', async () => {
  const dir = await root()
  await file(dir, 'apps/web/package.json', { scripts: { dev: 'vite --port 5174', preview: 'vite --port=5174' } })
  await file(dir, 'packages/site/package.json', { scripts: { start: 'next start -p 3001' } })
  await file(dir, 'apps/not-directory', 'ignore')
  const found = await discoverProject(dir)
  expect(found.status).toBe('ambiguous'); expect(found.targets).toHaveLength(2)
  expect((await discoverProject(dir, { app: 'apps/web' })).selected).toMatchObject({ url: 'http://localhost:5174/', app: 'apps/web' })
  expect((await discoverProject(dir, {}, { targetUrl: 'http://localhost:9000' })).selected).toMatchObject({ url: 'http://localhost:9000/', app: '.' })
})
it('discovers literal Vite port and conventional suites without approving them', async () => {
  const dir = await root()
  await file(dir, 'package.json', {})
  await file(dir, 'vite.config.ts', 'export default {server: {port: 5174}}; throw new Error("never executed")')
  await file(dir, 'e2e/acceptance.json', { version: 1, cases: [], baseUrl: 'http://localhost:5174' })
  await file(dir, '.devflow/midscene/suites/acceptance.json', { version: 2 })
  const result = await discoverProject(dir)
  expect(result.status).toBe('ready'); expect(result.targets).toHaveLength(1); expect(result.suites).toHaveLength(1)
  await file(dir, '.devflow/midscene/suites/acceptance.json', { version: 1 })
  expect((await discoverProject(dir)).suites).toHaveLength(1)
})
it('uses explicit choices, permits custom app locations, and preserves worktree isolation', async () => {
  const one = await root(); const two = await root()
  await file(one, 'frontend/package.json', { scripts: { dev: 'vite --port 5000' } })
  await writeSettings(one, { app: 'frontend', targetUrl: 'http://localhost:5001' })
  expect((await discoverProject(one, await readSettings(one), { targetUrl: 'http://localhost:5002' })).selected).toMatchObject({ app: 'frontend', url: 'http://localhost:5002/' })
  expect((await discoverProject(two)).status).toBe('unavailable')
})
it('fails loud on malformed JSON, excessive candidates and unreadable layout', async () => {
  const dir = await root()
  await file(dir, 'package.json', [])
  await expect(discoverProject(dir)).rejects.toThrow('object')
  await rm(join(dir, 'package.json'))
  await file(dir, 'apps', 'not a directory')
  await expect(discoverProject(dir)).rejects.toThrow()
  await rm(join(dir, 'apps'))
  await mkdir(join(dir, 'apps'))
  await Promise.all(Array.from({ length: 257 }, (_, i) => file(dir, `apps/${i}`, '')))
  await expect(discoverProject(dir)).rejects.toThrow('Too many')
})

it('rejects linked workspace containers and reports directory inspection errors', async () => {
  const dir = await root(); const outside = await root()
  await symlink(outside, join(dir, 'apps'), 'junction')
  await expect(discoverProject(dir)).rejects.toThrow('symbolic links')
  vi.spyOn(fs, 'lstat').mockRejectedValueOnce(new Error('inspection denied'))
  await expect(discoverProject(dir)).rejects.toThrow('inspection denied')
})

it('bounds plugin writes and keeps them under Devflow', async () => {
  const dir = await root()
  await expect(writeProjectFile(dir, 'outside', '')).rejects.toThrow('under .devflow')
  await expect(writeProjectFile(dir, '.devflow/large', 'a'.repeat(262145))).rejects.toThrow('size limit')
})
it('excludes concurrent writers and removes the operation lock after success or failure', async () => {
  const dir = await root()
  await withProjectMutation(dir, async () => {
    await expect(withProjectMutation(dir, async () => {})).rejects.toThrow('MIDSCENE_PROJECT_BUSY')
  })
  await expect(withProjectMutation(dir, async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
  expect(await readdir(join(dir, '.devflow/midscene'))).toEqual([])
  vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('access denied'))
  await expect(withProjectMutation(dir, async () => {})).rejects.toThrow('access denied')
})

it('rejects a file replaced between open and identity verification', async () => {
  const dir = await root(); await file(dir, 'input', 'original')
  const original = fs.open
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await original(...args)
    await fs.rename(join(dir, 'input'), join(dir, 'old'))
    await file(dir, 'input', 'replacement')
    return handle
  })
  await expect(readProjectFile(dir, 'input')).rejects.toThrow('changed while opening')
})
it('rejects a parent redirected after inspection before reading outside bytes', async () => {
  const dir = await root(); const outside = await root()
  await file(dir, '.devflow/midscene/settings.json', '{}')
  await file(outside, 'settings.json', '{"outside":"private"}')
  const original = fs.lstat
  let swapped = false
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    const info = await original(...args)
    if (!swapped && args[0] === join(dir, '.devflow/midscene/settings.json')) {
      swapped = true
      await fs.rename(join(dir, '.devflow/midscene'), join(dir, '.devflow/midscene-old'))
      await symlink(outside, join(dir, '.devflow/midscene'), 'junction')
    }
    return info
  })
  await expect(readSettings(dir)).rejects.toThrow('symbolic links')
})
it('does not write settings content through a redirected temporary-file parent', async () => {
  const dir = await root(); const outside = await root()
  const original = fs.open
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    await fs.rename(join(dir, '.devflow/midscene'), join(dir, '.devflow/midscene-old'))
    await symlink(outside, join(dir, '.devflow/midscene'), 'junction')
    return original(...args)
  })
  await expect(writeSettings(dir, { targetUrl: 'http://localhost:3000' })).rejects.toThrow('symbolic links')
  expect(await readdir(outside)).toEqual([])
})

it('persists optional deployment limits without inventing unspecified choices', async () => {
  const dir = await root()
  const settings = { limits: { timeoutMs: 60000, cleanupTimeoutMs: 4000, maxSteps: 50 } }
  await writeSettings(dir, settings)
  expect(await readSettings(dir)).toEqual(settings)
  expect(parseProjectSettings({ limits: { maxSteps: 3 } })).toEqual({ limits: { maxSteps: 3 } })
  expect(parseProjectSettings({ limits: {} })).toEqual({ limits: {} })
})
it.each([0, -1, 0.5, '50', Number.MAX_SAFE_INTEGER + 1, Infinity])('rejects invalid deployment limit %s', (value) => {
  expect(() => parseProjectSettings({ limits: { maxSteps: value } })).toThrow('positive safe integers')
})
