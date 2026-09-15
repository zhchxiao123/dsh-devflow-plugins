import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ lstat: vi.fn() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), lstat: boundary.lstat }))
import { workspaceIdentity, within } from '../src/identity.ts'

const exec = promisify(execFile)
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'midscene-identity-boundary-'))
  await exec('git', ['init', '-q'], { cwd: dir })
  await writeFile(join(dir, 'tracked'), 'original')
  await exec('git', ['add', '.'], { cwd: dir })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: dir })
  boundary.lstat.mockReset()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('refuses to fingerprint when filesystem inspection fails for reasons other than deletion', async () => {
  for (const failure of [Object.assign(new Error('denied'), { code: 'EACCES' }), new Error('failed'), 'unexpected rejection']) {
    boundary.lstat.mockRejectedValueOnce(failure)
    await expect(workspaceIdentity(dir)).rejects.toBe(failure)
  }
})

it('refuses a tracked path replaced by a directory instead of hashing it as a deleted file', async () => {
  await rm(join(dir, 'tracked'))
  await mkdir(join(dir, 'tracked'))
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  boundary.lstat.mockImplementation(actual.lstat)
  await expect(workspaceIdentity(dir)).rejects.toThrow('Unsupported workspace entry')
})

it('distinguishes the root, descendants, parent, and sibling paths without string-prefix containment', () => {
  expect(within(dir, dir)).toBe(true)
  expect(within(dir, join(dir, 'child'))).toBe(true)
  expect(within(dir, join(dir, '..'))).toBe(false)
  expect(within(dir, join(dir, '..', 'other'))).toBe(false)
  expect(within(dir, dir + '-sibling')).toBe(false)
})

it('excludes only root Devflow runtime state while application, suite, nested and similarly named paths remain bound', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  boundary.lstat.mockImplementation(actual.lstat)
  const initial = await workspaceIdentity(dir)
  await mkdir(join(dir, '.devflow'))
  await writeFile(join(dir, '.devflow', 'journal.jsonl'), 'card created')
  expect(await workspaceIdentity(dir)).toEqual(initial)
  await exec('git', ['add', '.devflow'], { cwd: dir })
  await writeFile(join(dir, '.devflow', 'journal.jsonl'), 'card claimed and transitioned')
  expect(await workspaceIdentity(dir)).toEqual(initial)
  for (const path of ['suite.json', 'app.ts', '.devflow-other', 'nested/.devflow/journal.jsonl']) {
    await mkdir(join(dir, 'nested', '.devflow'), { recursive: true })
    await writeFile(join(dir, path), 'changed')
    expect((await workspaceIdentity(dir)).workspaceSha256).not.toBe(initial.workspaceSha256)
    await rm(join(dir, path))
  }
  await rm(join(dir, '.devflow'), { recursive: true })
  await exec('git', ['reset', '-q', '--', '.devflow'], { cwd: dir })
  await writeFile(join(dir, '.devflow'), 'runtime root represented as a file')
  expect(await workspaceIdentity(dir)).toEqual(initial)
})
