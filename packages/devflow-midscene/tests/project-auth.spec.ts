import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLogin, loginPath, loginStatus } from '../src/project-auth.ts'
let root: string
let workspace: string
const target = 'https://app.example.test/'
const cookie = { name: 'session', value: 'private-secret', domain: 'app.example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'midscene-auth-'))); workspace = join(root, 'workspace'); await fs.mkdir(workspace) })
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
it('isolates login by origin and role, not page path', () => {
  expect(loginPath(root, target, 'reader')).toBe(loginPath(root, target + 'page', 'reader'))
  expect(loginPath(root, target, 'reader')).not.toBe(loginPath(root, target, 'admin'))
  expect(loginPath(root, target, '')).not.toBe(loginPath(root, 'https://other.test', ''))
})
it('imports only private target state and reports no values', async () => {
  const source = join(root, 'input.json'); const destination = loginPath(root, target, '')
  expect(await loginStatus(destination, workspace, target)).toBe('missing')
  await fs.writeFile(source, JSON.stringify({ cookies: [cookie], origins: [], extra: 'not-published' }), { mode: 0o600 })
  await importLogin(source, destination, workspace, target)
  expect(await loginStatus(destination, workspace, target)).toBe('available')
  expect(JSON.parse(await fs.readFile(destination, 'utf8'))).toEqual({ cookies: [cookie], origins: [] })
  expect((await fs.readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false)
})
it('rejects empty, expired, malformed, non-file and inaccessible inputs', async () => {
  const source = join(root, 'input.json'); const destination = loginPath(root, target, '')
  expect(await loginStatus(root, workspace, target)).toBe('invalid')
  for (const value of [{ cookies: [], origins: [] }, { cookies: [{ ...cookie, expires: 1 }], origins: [] }]) {
    await fs.writeFile(source, JSON.stringify(value), { mode: 0o600 })
    await expect(importLogin(source, destination, workspace, target)).rejects.toThrow('LOGIN_INVALID')
    expect(await loginStatus(destination, workspace, target)).toBe('missing')
  }
  await fs.writeFile(source, 'not-json')
  expect(await loginStatus(source, workspace, target)).toBe('invalid')
  await expect(importLogin(source, destination, workspace, target)).rejects.toThrow('LOGIN_INVALID')
  expect(await loginStatus(join(source, 'child'), workspace, target)).toBe('invalid')
})
it('supports live persistent cookies and local storage but rejects foreign or repository state', async () => {
  const source = join(root, 'input.json'); const destination = loginPath(root, target, '')
  for (const value of [
    { cookies: [{ ...cookie, expires: Date.now() / 1000 + 1000 }], origins: [] },
    { cookies: [], origins: [{ origin: 'https://app.example.test', localStorage: [{ name: 'token', value: 'private' }] }] },
  ]) {
    await fs.writeFile(source, JSON.stringify(value), { mode: 0o600 })
    await importLogin(source, destination, workspace, target)
    expect(await loginStatus(destination, workspace, target)).toBe('available')
  }
  await fs.writeFile(source, JSON.stringify({ cookies: [], origins: [{ origin: 'https://app.example.test', localStorage: [] }] }))
  expect(await loginStatus(source, workspace, target)).toBe('invalid')
  await fs.writeFile(source, JSON.stringify({ cookies: [{ ...cookie, domain: 'foreign.test' }], origins: [] }))
  await expect(importLogin(source, destination, workspace, target)).rejects.toThrow('LOGIN_INVALID')
  const repoInput = join(workspace, 'login.json'); await fs.writeFile(repoInput, '{}', { mode: 0o600 })
  await expect(importLogin(repoInput, destination, workspace, target)).rejects.toThrow('outside the workspace')
})
