import { chmod, realpath, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseStorageState, readPrivateJson } from '../src/auth-state.ts'
import { verifyDeploymentRecord } from '../src/deployment.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const cookie = { name: 'session', value: 'secret', domain: 'app.example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }
it('accepts only target-scoped cookies and local storage without preserving extra profile fields', () => {
  const state = { cookies: [cookie, { ...cookie, domain: '.example.test' }], origins: [{ origin: 'https://app.example.test', localStorage: [{ name: 'a', value: 'b' }] }], extra: 'discard' }
  expect(parseStorageState(state, 'https://app.example.test')).toEqual({ cookies: state.cookies, origins: state.origins })
  for (const value of [null, [], {}, { cookies: [], origins: false }, { cookies: [null], origins: [] }, { cookies: [{ ...cookie, domain: 'other.test' }], origins: [] }, { cookies: [{ ...cookie, name: 1 }], origins: [] }, { cookies: [{ ...cookie, expires: Infinity }], origins: [] }, { cookies: [{ ...cookie, httpOnly: 1 }], origins: [] }, { cookies: [{ ...cookie, secure: 1 }], origins: [] }, { cookies: [{ ...cookie, sameSite: 'invalid' }], origins: [] }, { cookies: [], origins: [{ origin: 'https://other.test', localStorage: [] }] }, { cookies: [], origins: [{ origin: 'https://app.example.test', localStorage: false }] }]) expect(() => parseStorageState(value, 'https://app.example.test')).toThrow()
})
it('requires private external files and binds deployment receipt to exact source and build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'midscene-private-')); roots.push(root)
  const path = join(root, 'state.json')
  const identity = { commit: 'commit', workspaceSha256: 'source' }
  await writeFile(path, JSON.stringify({ version: 1, ...identity, buildId: 'build' }), { mode: 0o600 })
  expect(await readPrivateJson(path, join(root, 'workspace'))).toMatchObject({ version: 1 })
  await verifyDeploymentRecord(path, join(root, 'workspace'), identity, 'build')
  await expect(readPrivateJson(path, await realpath(root))).rejects.toThrow('outside workspace')
  await expect(verifyDeploymentRecord(path, join(root, 'workspace'), identity, 'other')).rejects.toThrow('does not match')
  for (const value of [null, {}, { version: 1 }, { version: 1, commit: 'wrong' }, { version: 1, commit: 'commit' }, { version: 1, ...identity }, { version: 1, commit: 'commit', workspaceSha256: 'wrong' }]) {
    await writeFile(path, JSON.stringify(value))
    await expect(verifyDeploymentRecord(path, join(root, 'workspace'), identity, 'build')).rejects.toThrow()
  }
  await chmod(path, 0o644)
  // Windows chmod exposes no POSIX group/other bits; the reader leaves ACL policy to the host.
  if (process.platform === 'win32')
    expect(await readPrivateJson(path, join(root, 'workspace'))).toMatchObject({ version: 1 })
  else
    await expect(readPrivateJson(path, join(root, 'workspace'))).rejects.toThrow('owner-only')
  await chmod(path, 0o600)
  await writeFile(path, ' '.repeat(1024 * 1024 + 1))
  await expect(readPrivateJson(path, join(root, 'workspace'))).rejects.toThrow('owner-only')
})
