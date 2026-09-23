import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectWorkspaceEvidence } from '../src/workspace-evidence.ts'
import type { WorkspaceEvidenceOptions } from '../src/workspace-evidence.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath), open: vi.fn(actual.open) }
})

const execute = promisify(execFile)
const options: WorkspaceEvidenceOptions = { maxBytes: 32_768, maxFiles: 12, maxFileBytes: 4096, timeoutMs: 5000 }
const roots: string[] = []
async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout
}
async function repository(commit = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-workspace-')); roots.push(root)
  await git(root, 'init', '-q')
  await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(root, 'app.ts'), 'export const value = 1\n')
  if (commit) { await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'fixture') }
  return root
}
afterEach(async () => {
  vi.unstubAllEnvs(); vi.mocked(lstat).mockReset(); vi.mocked(realpath).mockReset(); vi.mocked(open).mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('workspace evidence', () => {
  it('collects staged, unstaged, untracked and related tests from the canonical workspace', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.spec.ts'), 'test("value", () => value === 1)\n')
    await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'test')
    await writeFile(join(root, 'app.ts'), 'export const value = 2\n'); await git(root, 'add', 'app.ts')
    await writeFile(join(root, 'app.ts'), 'export const value = 3\n')
    await writeFile(join(root, 'new.ts'), 'export const added = true\n')
    const before = await git(root, 'status', '--porcelain=v1')
    const evidence = await collectWorkspaceEvidence(root, options)
    expect(evidence.workspace).toBe(await realpath(root))
    expect(evidence.head).toBe((await git(root, 'rev-parse', 'HEAD')).trim())
    expect(evidence.diff).toContain('STAGED'); expect(evidence.diff).toContain('UNSTAGED')
    expect(evidence.diff).toContain('-export const value = 1'); expect(evidence.diff).toContain('+export const value = 3')
    expect(evidence.untracked).toEqual(['new.ts'])
    expect(evidence.files.map(item => item.path)).toEqual(['app.ts', 'new.ts', 'app.spec.ts'])
    expect(evidence.gaps).toEqual([expect.stringContaining('Related evidence')])
    expect((await collectWorkspaceEvidence(root, options)).digest).toBe(evidence.digest)
    expect(await git(root, 'status', '--porcelain=v1')).toBe(before)
  })

  it('keeps a subdirectory workspace separate from changed sibling projects', async () => {
    const root = await repository()
    const workspace = join(root, 'app-a'); const sibling = join(root, 'app-b')
    await mkdir(workspace); await mkdir(sibling)
    await writeFile(join(workspace, 'entry.ts'), 'export const active = 1\n')
    await writeFile(join(sibling, 'private.ts'), 'export const siblingBusinessRule = 1\n')
    await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'two projects')
    await writeFile(join(workspace, 'entry.ts'), 'export const active = 2\n')
    await writeFile(join(sibling, 'private.ts'), 'export const siblingBusinessRule = 2\n')
    const evidence = await collectWorkspaceEvidence(workspace, options)
    expect(evidence.workspace).toBe(await realpath(workspace))
    expect(evidence.files.map(item => item.path)).toEqual(['entry.ts'])
    expect(evidence.diff).toContain('+export const active = 2')
    expect(JSON.stringify(evidence)).not.toContain('siblingBusinessRule')
    expect(evidence.status).not.toContain('app-b')
    await writeFile(join(sibling, 'private.ts'), 'export const siblingBusinessRule = 3\n')
    expect((await collectWorkspaceEvidence(workspace, options)).digest).toBe(evidence.digest)
  })

  it('reuses omitted hidden and oversized evidence until their local metadata changes', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    await writeFile(join(root, '.local-note'), 'private note')
    await writeFile(join(root, 'oversized.ts'), 'a'.repeat(options.maxFileBytes + 1))
    const before = await collectWorkspaceEvidence(root, options)
    expect(before.files.map(item => item.path)).toEqual(['app.ts'])
    expect(before.gaps).toContain('A hidden, sensitive, unsupported, or unsafe changed path was excluded.')
    expect(before.gaps).toContain('File evidence excluded: oversized.ts')
    expect((await collectWorkspaceEvidence(root, options)).digest).toBe(before.digest)
    expect(JSON.stringify(before)).not.toContain('private note')
    await writeFile(join(root, '.local-note'), 'a different private note')
    const hiddenChanged = await collectWorkspaceEvidence(root, options)
    expect(hiddenChanged.digest).not.toBe(before.digest)
    expect((await collectWorkspaceEvidence(root, options)).digest).toBe(hiddenChanged.digest)
    await writeFile(join(root, 'oversized.ts'), 'b'.repeat(options.maxFileBytes + 2))
    const oversizedChanged = await collectWorkspaceEvidence(root, options)
    expect(oversizedChanged.digest).not.toBe(hiddenChanged.digest)
    expect((await collectWorkspaceEvidence(root, options)).digest).toBe(oversizedChanged.digest)
  })

  it('invalidates omitted content when only its staged blob changes', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    await git(root, 'add', 'app.ts')
    await writeFile(join(root, 'app.ts'), 'x'.repeat(options.maxFileBytes + 1))
    const before = await collectWorkspaceEvidence(root, options)
    expect(before.files).toEqual([])
    expect((await collectWorkspaceEvidence(root, options)).digest).toBe(before.digest)
    const blobFile = join(root, '.index-fixture')
    await writeFile(blobFile, 'export const value = 3\n')
    const oid = (await git(root, 'hash-object', '-w', blobFile)).trim()
    await rm(blobFile)
    await git(root, 'update-index', '--cacheinfo', '100644', oid, 'app.ts')
    const after = await collectWorkspaceEvidence(root, options)
    expect(after.status).toBe(before.status)
    expect(after.files).toEqual(before.files)
    expect(after.digest).not.toBe(before.digest)
    expect((await collectWorkspaceEvidence(root, options)).digest).toBe(after.digest)
  })

  it('fingerprints content changes even when status and file size are unchanged', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    const first = await collectWorkspaceEvidence(root, options)
    await writeFile(join(root, 'app.ts'), 'export const value = 3\n')
    const second = await collectWorkspaceEvidence(root, options)
    expect(second.status).toBe(first.status); expect(second.digest).not.toBe(first.digest)
    expect(second.files[0]?.digest).not.toBe(first.files[0]?.digest)
  })

  it('ignores its own metadata without turning every stored assessment stale', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    const before = await collectWorkspaceEvidence(root, options)
    await mkdir(join(root, '.devflow')); await mkdir(join(root, '.jev'))
    await writeFile(join(root, '.devflow', 'journal.jsonl'), 'private recorded evidence')
    await writeFile(join(root, '.jev', 'run.json'), 'private evaluation')
    const after = await collectWorkspaceEvidence(root, options)
    expect(after).toEqual(before)
    await writeFile(join(root, '.user-settings'), 'user-owned hidden change')
    const hidden = await collectWorkspaceEvidence(root, options)
    expect(hidden.gaps).toContain('A hidden, sensitive, unsupported, or unsafe changed path was excluded.')
    expect(hidden.digest).not.toBe(before.digest)
  })

  it('loads a related source for a changed test and skips invalid text companions', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.spec.ts'), 'test("new behavior", () => value === 1)\n')
    const evidence = await collectWorkspaceEvidence(root, options)
    expect(evidence.files.map(item => item.path)).toEqual(['app.spec.ts', 'app.ts'])
    await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    await git(root, 'add', 'app.spec.ts'); await git(root, 'commit', '-qm', 'test')
    await writeFile(join(root, 'app.spec.ts'), Buffer.from([0xff, 0xfe]))
    await git(root, 'add', 'app.spec.ts'); await git(root, 'commit', '-qm', 'binary test')
    expect((await collectWorkspaceEvidence(root, options)).files.map(item => item.path)).toEqual(['app.ts'])
  })

  it('does not return hidden files, credentials, binary data or symlink targets', async () => {
    const root = await repository()
    const outside = await mkdtemp(join(tmpdir(), 'jev-external-')); roots.push(outside)
    await writeFile(join(outside, 'outside.ts'), 'PRIVATE_EXTERNAL_CONTENT')
    await symlink(join(outside, 'outside.ts'), join(root, 'link.ts'))
    await symlink(outside, join(root, 'linked'))
    await writeFile(join(root, '.env'), 'HIDDEN_SECRET')
    await writeFile(join(root, 'credentials.json'), 'SENSITIVE_NAME')
    await writeFile(join(root, 'config.ts'), 'const apiKey = "superSecretValue1234"\n')
    await writeFile(join(root, 'binary.ts'), Buffer.from([65, 0, 66]))
    const evidence = await collectWorkspaceEvidence(root, options)
    const serialized = JSON.stringify(evidence)
    for (const secret of ['PRIVATE_EXTERNAL_CONTENT', 'HIDDEN_SECRET', 'SENSITIVE_NAME', 'superSecretValue1234']) expect(serialized).not.toContain(secret)
    expect(evidence.files).toEqual([]); expect(evidence.diff).toBe('')
    expect(evidence.gaps.length).toBeGreaterThan(1)
    expect((await collectWorkspaceEvidence(root, options)).digest).toBe(evidence.digest)
  })

  it('excludes credentials removed from tracked source while collecting safe deletions and renames', async () => {
    const root = await repository()
    await writeFile(join(root, 'config.ts'), 'const password = "oldSecretValue1234"\n')
    await writeFile(join(root, 'deleted.ts'), 'export const obsolete = true\n')
    await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'old files')
    await writeFile(join(root, 'config.ts'), 'export const safe = true\n')
    await git(root, 'rm', 'deleted.ts'); await git(root, 'mv', 'app.ts', 'renamed.ts')
    const evidence = await collectWorkspaceEvidence(root, options)
    expect(JSON.stringify(evidence)).not.toContain('oldSecretValue1234')
    expect(evidence.diff).toContain('-export const obsolete = true')
    expect(evidence.status).toContain('renamed.ts')
    expect(evidence.gaps).toContain('Sensitive, binary, or symlink diff excluded: config.ts')
  })

  it('collects staged files before the first commit and handles non-Git directories', async () => {
    const root = await repository(false); await git(root, 'add', '.')
    const unborn = await collectWorkspaceEvidence(root, options)
    expect(unborn.head).toBe(''); expect(unborn.diff).toContain('+export const value = 1')
    expect(unborn.gaps).toContain('Repository has no readable HEAD; staged changes are compared with the empty tree.')
    const empty = await mkdtemp(join(tmpdir(), 'jev-no-git-')); roots.push(empty)
    const unavailable = await collectWorkspaceEvidence(empty, options)
    expect(unavailable.gaps).toEqual(['Workspace Git evidence is unavailable.'])
  })

  it('makes omitted evidence explicit and bounds returned text and inspected files', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.ts'), 'x'.repeat(6000))
    await writeFile(join(root, 'b.ts'), 'export const b = 2\n')
    const oversized = await collectWorkspaceEvidence(root, options)
    expect(oversized.gaps).toContain('File evidence excluded: app.ts')
    const capped = await collectWorkspaceEvidence(root, { ...options, maxFiles: 1, maxBytes: 80 })
    expect(capped.files.length).toBeLessThanOrEqual(1)
    expect(Buffer.byteLength(capped.status + capped.diff + capped.files.map(item => item.excerpt).join(''))).toBeLessThanOrEqual(80)
    expect(capped.gaps).toContain('Changed file count exceeds evidence budget.')
    const tiny = await collectWorkspaceEvidence(root, { ...options, maxBytes: 2 })
    expect(tiny.gaps).toContain('Workspace Git evidence is unavailable.')
  })

  it('bounds path-scoped patches and their framing without silently clipping evidence', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    const patchCap = await collectWorkspaceEvidence(root, { ...options, maxFileBytes: 40 })
    expect(patchCap.gaps).toContain('Diff unavailable or over budget: app.ts')
    const full = await collectWorkspaceEvidence(root, options)
    const size = Buffer.byteLength(full.status + full.diff + full.files.map(item => item.excerpt).join(''))
    const exact = await collectWorkspaceEvidence(root, { ...options, maxBytes: size - 1 })
    expect(exact.gaps).toContain('Diff evidence exceeds byte budget: app.ts')
    await writeFile(join(root, 'app.ts'), 'export const value = 1\n')
    await writeFile(join(root, 'a.ts'), 'a'.repeat(80))
    await writeFile(join(root, 'b.ts'), 'b')
    const statusCap = await collectWorkspaceEvidence(root, { ...options, maxBytes: 90 })
    expect(statusCap.gaps).toContain('Status evidence exceeds byte budget.')
  })

  it('marks content mutation and disappearance during collection as non-reusable', async () => {
    const root = await repository(); await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let reads = 0
    vi.mocked(lstat).mockImplementation(async (path, settings) => {
      if (String(path) === join(await actual.realpath(root), 'app.ts') && ++reads === 3) await writeFile(path, 'export const value = 3\n')
      return actual.lstat(path, settings)
    })
    expect((await collectWorkspaceEvidence(root, options)).gaps.some(gap => /changed during collection/.test(gap))).toBe(true)
    reads = 0
    vi.mocked(lstat).mockImplementation(async (path, settings) => {
      if (String(path) === join(await actual.realpath(root), 'app.ts') && ++reads === 3) await rm(path)
      return actual.lstat(path, settings)
    })
    expect((await collectWorkspaceEvidence(root, options)).gaps.some(gap => /changed|unavailable/.test(gap))).toBe(true)
  })

  it('rejects Git paths when the repository root no longer matches the session directory', async () => {
    const root = await repository(); await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let resolutions = 0
    vi.mocked(realpath).mockImplementation(async (path, settings) => ++resolutions === 2 ? '/outside/workspace' : actual.realpath(path, settings))
    const evidence = await collectWorkspaceEvidence(root, options)
    expect(evidence.gaps).toContain('Workspace Git evidence is unavailable.')
    expect(evidence.files).toEqual([])
    expect(evidence.diff).toBe('')
  })

  it('rejects a path resolving outside the workspace and notices concurrent status changes', async () => {
    const root = await repository(); await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(realpath).mockImplementation(async (path, settings) => {
      if (String(path).endsWith('/app.ts')) return '/outside/app.ts'
      return actual.realpath(path, settings)
    })
    expect((await collectWorkspaceEvidence(root, options)).gaps).toContain('File evidence excluded: app.ts')
    vi.mocked(realpath).mockReset()
    vi.mocked(lstat).mockImplementation(async (path, settings) => {
      if (String(path).endsWith('app.spec.ts')) await writeFile(join(root, 'concurrent.ts'), 'new concurrent file')
      return actual.lstat(path, settings)
    })
    expect((await collectWorkspaceEvidence(root, options)).gaps).toContain('Workspace status changed while evidence was collected.')
  })

  it('rejects a file growing between stat and read and bounds omission records', async () => {
    const root = await repository(); await writeFile(join(root, 'app.ts'), 'export const value = 2\n')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode)
      const info = await handle.stat()
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        await writeFile(path, 'x'.repeat(options.maxFileBytes + 1))
        return info
      })
      return handle
    })
    expect((await collectWorkspaceEvidence(root, options)).gaps).toContain('File evidence excluded: app.ts')
    vi.mocked(open).mockReset()
    for (let index = 0; index < 12; index++) await writeFile(join(root, `file${index}.ts`), 'export const v = 1\n')
    await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'files')
    for (let index = 0; index < 12; index++) await writeFile(join(root, `file${index}.ts`), 'export const v = 2\n')
    await git(root, 'add', '.')
    for (let index = 0; index < 12; index++) await writeFile(join(root, `file${index}.ts`), 'export const v = 3\n')
    const capped = await collectWorkspaceEvidence(root, { ...options, maxFileBytes: 40 })
    expect(capped.gaps).toHaveLength(options.maxFiles + 5)
  })

  it('honors abort, deadline and rejects invalid budgets', async () => {
    const root = await repository()
    const cancelled = new AbortController(); cancelled.abort(new Error('user cancelled'))
    await expect(collectWorkspaceEvidence(root, options, cancelled.signal)).rejects.toThrow('user cancelled')
    const pending = new AbortController()
    const collecting = collectWorkspaceEvidence(root, options, pending.signal); pending.abort(new Error('stop now'))
    await expect(collecting).rejects.toThrow('stop now')
    const timed = await collectWorkspaceEvidence(root, { ...options, timeoutMs: 1 })
    expect(timed.gaps).toContain('Workspace evidence collection timed out.')
    await expect(collectWorkspaceEvidence(root, { ...options, maxFiles: 0 })).rejects.toThrow('positive safe integers')
  })

  it('does not inherit ambient Git repository overrides or execute external diff helpers', async () => {
    const root = await repository(); const other = await repository()
    await writeFile(join(root, 'app.ts'), 'export const value = 9\n')
    await git(root, 'config', 'diff.external', 'invalid-helper-command')
    vi.stubEnv('GIT_DIR', join(other, '.git')); vi.stubEnv('GIT_WORK_TREE', other)
    const evidence = await collectWorkspaceEvidence(root, options)
    expect(evidence.workspace).toBe(await realpath(root)); expect(evidence.diff).toContain('+export const value = 9')
    expect(await readFile(join(other, 'app.ts'), 'utf8')).toBe('export const value = 1\n')
  })
})
