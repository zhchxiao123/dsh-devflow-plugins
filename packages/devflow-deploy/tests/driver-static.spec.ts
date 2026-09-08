import { mkdir, mkdtemp, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStaticDriver, prunable } from '../src/drivers/static/driver.ts'
import { DeployFailure, DeployRunContext } from '../src/run.ts'
import type { ResolvedTarget } from '../src/types.ts'
import type { StaticSpec } from '../src/drivers/static/spec.ts'
import { createRemoteDouble, usePath } from './remote-double.ts'
import type { RemoteDouble } from './remote-double.ts'

const HOST = 'deploy@example.test'
const BASE_URL = 'https://example.test'
const TARGET: ResolvedTarget<StaticSpec> = { name: 'landing', spec: { dir: 'dist', entry: 'index.html' } }

let remote: RemoteDouble
let root: string
let ctx: Context
let dispose: () => void
let restorePath: () => void
let tick = 0

beforeEach(async () => {
  remote = await createRemoteDouble()
  root = await mkdtemp(join(tmpdir(), 'deploy-ws-'))
  ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  dispose = (): void => {
    void fiber.dispose()
  }
  restorePath = usePath(remote)
  tick = 0
})

afterEach(() => {
  dispose()
  restorePath()
})

function run(): DeployRunContext {
  return new DeployRunContext(ctx, {
    root,
    remoteTimeoutMs: 20_000,
    logTailBytes: 65_536,
    graceMs: 1_000,
    // Each run gets its own minute, so successive deploys get distinct ids.
    clock: () => new Date(Date.UTC(2026, 8, 3, 19, tick++, 0)),
  })
}

function driver(keepReleases = 5) {
  return createStaticDriver({
    host: HOST,
    remoteWebRoot: remote.remoteWebRoot,
    remoteReleasesRoot: remote.remoteReleasesRoot,
    baseUrl: BASE_URL,
    keepReleases,
  })
}

async function buildArtifact(body = '<h1>one</h1>'): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist', 'index.html'), body)
}

async function servedContent(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(join(remote.localWebRoot, 'landing', 'index.html'), 'utf8')
}

describe('deploying a static target', () => {
  it('lands the artifact in its own release and serves it through the symlink', async () => {
    await buildArtifact()

    const outcome = await driver().deploy(run(), TARGET)

    expect(outcome.url).toBe('https://example.test/landing/')
    expect(basename(await readlink(join(remote.localWebRoot, 'landing')))).toBe(outcome.releaseId)
    await expect(servedContent()).resolves.toBe('<h1>one</h1>')
  })

  it('keeps the previous release on disk and moves the symlink to the new one', async () => {
    await buildArtifact('<h1>one</h1>')
    const first = await driver().deploy(run(), TARGET)
    await buildArtifact('<h1>two</h1>')

    const second = await driver().deploy(run(), TARGET)

    expect(second.releaseId).not.toBe(first.releaseId)
    expect(basename(await readlink(join(remote.localWebRoot, 'landing')))).toBe(second.releaseId)
    await expect(servedContent()).resolves.toBe('<h1>two</h1>')
    const { readdir } = await import('node:fs/promises')
    await expect(readdir(join(remote.localReleasesRoot, 'landing'))).resolves.toContain(first.releaseId)
  })

  it('leaves the live site byte-for-byte intact when the transfer fails', async () => {
    await buildArtifact('<h1>one</h1>')
    const first = await driver().deploy(run(), TARGET)
    await buildArtifact('<h1>two</h1>')
    process.env['DEPLOY_FAKE_FAIL'] = 'rsync'

    await expect(driver().deploy(run(), TARGET)).rejects.toThrow(DeployFailure)

    expect(basename(await readlink(join(remote.localWebRoot, 'landing')))).toBe(first.releaseId)
    await expect(servedContent()).resolves.toBe('<h1>one</h1>')
  })

  it('attributes a failed transfer to its phase and carries the command output', async () => {
    await buildArtifact()
    process.env['DEPLOY_FAKE_FAIL'] = 'rsync'

    let caught: DeployFailure | undefined
    try {
      await driver().deploy(run(), TARGET)
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.phase).toBe('transfer')
    expect(caught?.message).toContain('rsync refused')
  })
})

describe('the preflight boundary', () => {
  it.each([
    ['the artifact directory is missing', async () => undefined],
    ['the artifact directory is empty', async () => void await mkdir(join(root, 'dist'), { recursive: true })],
    ['the entry document is absent', async () => {
      await mkdir(join(root, 'dist'), { recursive: true })
      await writeFile(join(root, 'dist', 'other.html'), 'x')
    }],
  ])('refuses to touch the remote when %s', async (_label, prepare) => {
    await prepare()

    await expect(driver().deploy(run(), TARGET)).rejects.toThrow(DeployFailure)

    await expect(remote.calls()).resolves.toEqual([])
  })

  it('refuses an artifact whose symlink leaves it', async () => {
    await buildArtifact()
    const outside = join(root, 'secret.txt')
    await writeFile(outside, 'private')
    await symlink(outside, join(root, 'dist', 'leak.txt'))

    await expect(driver().deploy(run(), TARGET)).rejects.toThrow(/symlink that leaves it/)
    await expect(remote.calls()).resolves.toEqual([])
  })

  it('refuses an artifact containing a dangling symlink', async () => {
    await buildArtifact()
    await symlink(join(root, 'gone.txt'), join(root, 'dist', 'dangling.txt'))

    await expect(driver().deploy(run(), TARGET)).rejects.toThrow(/symlink that leaves it/)
    await expect(remote.calls()).resolves.toEqual([])
  })

  it('walks nested directories looking for escaping symlinks', async () => {
    await buildArtifact()
    await mkdir(join(root, 'dist', 'assets'), { recursive: true })
    await writeFile(join(root, 'secret.txt'), 'private')
    await symlink(join(root, 'secret.txt'), join(root, 'dist', 'assets', 'leak.txt'))

    await expect(driver().deploy(run(), TARGET)).rejects.toThrow(/assets\/leak.txt/)
  })

  it('accepts a symlink that stays inside the artifact', async () => {
    await buildArtifact()
    await symlink(join(root, 'dist', 'index.html'), join(root, 'dist', 'home.html'))

    await expect(driver().deploy(run(), TARGET)).resolves.toHaveProperty('url', 'https://example.test/landing/')
  })

  it('rejects a path that is a file rather than a directory', async () => {
    await writeFile(join(root, 'dist'), 'not a directory')

    await expect(driver().deploy(run(), TARGET)).rejects.toThrow('is not a directory')
  })

  it('fails loud and untouched when the host does not answer', async () => {
    await buildArtifact()
    process.env['DEPLOY_FAKE_FAIL'] = 'ssh'

    let caught: DeployFailure | undefined
    try {
      await driver().deploy(run(), TARGET)
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.phase).toBe('preflight')
    expect(caught?.message).toContain('ssh refused')
  })
})

describe('status', () => {
  it('reports nothing deployed before the first deploy', async () => {
    const status = await driver().status(run(), TARGET)

    expect(status).toEqual({
      name: 'landing',
      kind: 'static',
      rollbackClass: { kind: 'atomic' },
      releases: [],
    })
  })

  it('reports the current release newest first with its address', async () => {
    await buildArtifact()
    const first = await driver().deploy(run(), TARGET)
    const second = await driver().deploy(run(), TARGET)

    const status = await driver().status(run(), TARGET)

    expect(status.currentRelease).toBe(second.releaseId)
    expect(status.url).toBe('https://example.test/landing/')
    expect(status.releases.map(release => release.id)).toEqual([second.releaseId, first.releaseId])
    expect(status.releases.filter(release => release.current).map(r => r.id)).toEqual([second.releaseId])
  })
})

describe('rollback', () => {
  it('returns the previous release without transferring anything', async () => {
    await buildArtifact('<h1>one</h1>')
    const first = await driver().deploy(run(), TARGET)
    await buildArtifact('<h1>two</h1>')
    await driver().deploy(run(), TARGET)
    const before = (await remote.calls()).filter(call => call.startsWith('rsync')).length

    const outcome = await driver().rollback?.(run(), TARGET)

    expect(outcome?.releaseId).toBe(first.releaseId)
    await expect(servedContent()).resolves.toBe('<h1>one</h1>')
    expect((await remote.calls()).filter(call => call.startsWith('rsync'))).toHaveLength(before)
  })

  it('returns to a named release', async () => {
    await buildArtifact('<h1>one</h1>')
    const first = await driver().deploy(run(), TARGET)
    await driver().deploy(run(), TARGET)
    await driver().deploy(run(), TARGET)

    await driver().rollback?.(run(), TARGET, first.releaseId)

    await expect(servedContent()).resolves.toBe('<h1>one</h1>')
  })

  it('names the available releases when the requested one does not exist', async () => {
    await buildArtifact()
    await driver().deploy(run(), TARGET)

    await expect(driver().rollback?.(run(), TARGET, 'nope')).rejects.toThrow(/has no release 'nope'/)
  })

  it('refuses when the target has never been deployed', async () => {
    await expect(driver().rollback?.(run(), TARGET)).rejects.toThrow(/no releases to roll back to/)
  })

  it('refuses when the current release is the only one', async () => {
    await buildArtifact()
    await driver().deploy(run(), TARGET)

    await expect(driver().rollback?.(run(), TARGET)).rejects.toThrow(/nothing to roll back to/)
  })

  it('adopts the newest release when the symlink is missing', async () => {
    await buildArtifact()
    const first = await driver().deploy(run(), TARGET)
    const { rm } = await import('node:fs/promises')
    await rm(join(remote.localWebRoot, 'landing'))

    await expect(driver().rollback?.(run(), TARGET)).resolves.toMatchObject({ releaseId: first.releaseId })
  })
})

describe('prunable', () => {
  it('keeps the retention window', () => {
    expect(prunable(['a', 'b', 'c', 'd'], 'd', 2)).toEqual(['a', 'b'])
  })

  it('never removes the current release or the one a rollback would return to', () => {
    expect(prunable(['a', 'b', 'c', 'd'], 'b', 1)).toEqual(['c'])
  })

  it('removes nothing when everything fits the window', () => {
    expect(prunable(['a', 'b'], 'b', 5)).toEqual([])
  })

  it('keeps the window when nothing is deployed', () => {
    expect(prunable(['a', 'b', 'c'], undefined, 2)).toEqual(['a'])
  })
})

describe('pruning during a deploy', () => {
  it('removes superseded releases past the window', async () => {
    await buildArtifact()
    const first = await driver(1).deploy(run(), TARGET)
    await driver(1).deploy(run(), TARGET)
    await driver(1).deploy(run(), TARGET)

    const { readdir } = await import('node:fs/promises')
    await expect(readdir(join(remote.localReleasesRoot, 'landing'))).resolves.not.toContain(first.releaseId)
  })

  it('keeps the rollback target even with a window of one', async () => {
    await buildArtifact()
    await driver(1).deploy(run(), TARGET)
    const second = await driver(1).deploy(run(), TARGET)
    await driver(1).deploy(run(), TARGET)

    const { readdir } = await import('node:fs/promises')
    await expect(readdir(join(remote.localReleasesRoot, 'landing'))).resolves.toContain(second.releaseId)
  })

  it('warns rather than fails when a superseded release cannot be removed', async () => {
    await buildArtifact()
    await driver(1).deploy(run(), TARGET)
    await driver(1).deploy(run(), TARGET)
    process.env['DEPLOY_FAKE_FAIL'] = 'prune'
    const third = run()

    await expect(driver(1).deploy(third, TARGET)).resolves.toHaveProperty('url', 'https://example.test/landing/')
    expect(third.recordedWarnings()[0]).toContain('could not be removed')
  })
})
