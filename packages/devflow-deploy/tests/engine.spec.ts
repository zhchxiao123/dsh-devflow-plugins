import { mkdir, mkdtemp, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeployEngine } from '../src/engine.ts'
import { ManifestError } from '../src/manifest.ts'
import { DriverRegistry, RollbackUnsupportedError, UnknownKindError } from '../src/registry.ts'
import { DeployFailure } from '../src/run.ts'
import { createStaticDriver } from '../src/drivers/static/driver.ts'
import type { TargetDriver } from '../src/types.ts'
import { createRemoteDouble, usePath } from './remote-double.ts'
import type { RemoteDouble } from './remote-double.ts'

let remote: RemoteDouble
let root: string
let ctx: Context
let dispose: () => void
let restorePath: () => void
let tick = 0

beforeEach(async () => {
  remote = await createRemoteDouble()
  root = await mkdtemp(join(tmpdir(), 'deploy-engine-'))
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

async function writeManifest(body: string): Promise<void> {
  await writeFile(join(root, 'deploy.yml'), body)
}

const STATIC_MANIFEST = [
  'targets:',
  '  landing:',
  '    kind: static',
  '    dir: dist',
].join('\n')

function engine(registry = defaultRegistry()): DeployEngine {
  return new DeployEngine(ctx, {
    root,
    manifestPath: 'deploy.yml',
    remoteTimeoutMs: 20_000,
    buildTimeoutMs: 20_000,
    logTailBytes: 65_536,
    graceMs: 1_000,
    clock: () => new Date(Date.UTC(2026, 8, 3, 19, tick++, 0)),
  }, registry)
}

function defaultRegistry(): DriverRegistry {
  const registry = new DriverRegistry()
  registry.register(createStaticDriver({
    host: 'deploy@example.test',
    remoteWebRoot: remote.remoteWebRoot,
    remoteReleasesRoot: remote.remoteReleasesRoot,
    baseUrl: 'https://example.test',
    keepReleases: 5,
  }))
  return registry
}

async function buildArtifact(body = '<h1>one</h1>'): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist', 'index.html'), body)
}

describe('deploy', () => {
  it('reports the driver outcome with the phases the run passed through', async () => {
    await writeManifest(STATIC_MANIFEST)
    await buildArtifact()

    const report = await engine().deploy('landing')

    expect(report.target).toBe('landing')
    expect(report.kind).toBe('static')
    expect(report.outcome.url).toBe('https://example.test/landing/')
    expect(report.timeline.map(entry => entry.phase))
      .toEqual(['resolve', 'preflight', 'transfer', 'activate', 'prune'])
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    expect(report.warnings).toEqual([])
  })

  it('runs a declared build before handing over to the driver', async () => {
    await writeManifest([
      'targets:',
      '  landing:',
      '    kind: static',
      '    build: mkdir -p dist && printf built > dist/index.html',
      '    dir: dist',
    ].join('\n'))

    const report = await engine().deploy('landing')

    expect(report.timeline.map(entry => entry.phase)).toContain('build')
    const { readFile } = await import('node:fs/promises')
    await expect(readFile(join(remote.remoteWebRoot, 'landing', 'index.html'), 'utf8')).resolves.toBe('built')
  })

  it('attributes a failing build to the build phase and never reaches the remote', async () => {
    await writeManifest([
      'targets:',
      '  landing:',
      '    kind: static',
      '    build: echo "no compiler" >&2; exit 7',
      '    dir: dist',
    ].join('\n'))

    let caught: DeployFailure | undefined
    try {
      await engine().deploy('landing')
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.phase).toBe('build')
    expect(caught?.message).toContain('exit code 7')
    expect(caught?.message).toContain('no compiler')
    await expect(remote.calls()).resolves.toEqual([])
  })

  it('carries the driver warnings into the report', async () => {
    await writeManifest(STATIC_MANIFEST)
    await buildArtifact()
    const registry = new DriverRegistry()
    registry.register(createStaticDriver({
      host: 'deploy@example.test',
      remoteWebRoot: remote.remoteWebRoot,
      remoteReleasesRoot: remote.remoteReleasesRoot,
      baseUrl: 'https://example.test',
      keepReleases: 1,
    }))
    await engine(registry).deploy('landing')
    await engine(registry).deploy('landing')
    process.env['DEPLOY_FAKE_FAIL'] = 'prune'

    const report = await engine(registry).deploy('landing')

    expect(report.warnings[0]).toContain('could not be removed')
  })
})

describe('resolution failures', () => {
  it('reports a missing manifest with its resolved path', async () => {
    await expect(engine().deploy('landing')).rejects.toThrow(join(root, 'deploy.yml'))
  })

  it('names the declared targets when the requested one is absent', async () => {
    await writeManifest(STATIC_MANIFEST)

    await expect(engine().deploy('nope')).rejects.toThrow(ManifestError)
    await expect(engine().deploy('nope')).rejects.toThrow('declared targets: landing')
  })

  it('names the registered kinds when the target declares an unregistered one', async () => {
    await writeManifest(['targets:', '  cluster:', '    kind: playbook'].join('\n'))

    await expect(engine().deploy('cluster')).rejects.toThrow(UnknownKindError)
    await expect(engine().deploy('cluster')).rejects.toThrow('registered kinds: static')
  })

  it('reports a driver-owned field issue with its field path', async () => {
    await writeManifest(['targets:', '  landing:', '    kind: static', '    dir: /etc'].join('\n'))

    await expect(engine().deploy('landing')).rejects.toThrow('targets.landing.dir')
  })
})

describe('status', () => {
  it('reports every declared target in declaration order', async () => {
    await writeManifest([
      'targets:',
      '  landing:',
      '    kind: static',
      '    dir: dist',
      '  docs:',
      '    kind: static',
      '    dir: dist',
    ].join('\n'))

    const report = await engine().status()

    expect(report.targets.map(target => target.name)).toEqual(['landing', 'docs'])
    expect(report.targets.every(target => target.rollbackClass.kind === 'atomic')).toBe(true)
  })

  it('reports one target when named', async () => {
    await writeManifest(STATIC_MANIFEST)
    await buildArtifact()
    const deployed = await engine().deploy('landing')

    const report = await engine().status('landing')

    expect(report.targets).toHaveLength(1)
    expect(report.targets[0]?.currentRelease).toBe(deployed.outcome.releaseId)
  })

  it('names the declared targets when the requested one is absent', async () => {
    await writeManifest(STATIC_MANIFEST)

    await expect(engine().status('nope')).rejects.toThrow('declared targets: landing')
  })
})

describe('rollback', () => {
  it('returns the target to its previous release', async () => {
    await writeManifest(STATIC_MANIFEST)
    await buildArtifact('<h1>one</h1>')
    const first = await engine().deploy('landing')
    await buildArtifact('<h1>two</h1>')
    await engine().deploy('landing')

    const report = await engine().rollback('landing')

    expect(report.outcome.releaseId).toBe(first.outcome.releaseId)
    expect(basename(await readlink(join(remote.remoteWebRoot, 'landing')))).toBe(first.outcome.releaseId)
  })

  it('returns to a named release', async () => {
    await writeManifest(STATIC_MANIFEST)
    await buildArtifact()
    const first = await engine().deploy('landing')
    await engine().deploy('landing')
    await engine().deploy('landing')

    const report = await engine().rollback('landing', first.outcome.releaseId)

    expect(report.outcome.releaseId).toBe(first.outcome.releaseId)
  })

  it('refuses when the target kind promises no rollback', async () => {
    await writeManifest(['targets:', '  cluster:', '    kind: playbook'].join('\n'))
    const registry = defaultRegistry()
    const playbook: TargetDriver<null> = {
      kind: 'playbook',
      rollbackClass: { kind: 'unsupported', reason: 'the delegated orchestrator decides reversibility' },
      validate: () => null,
      deploy: () => Promise.resolve({ releaseId: 'x' }),
      status: () => Promise.resolve({
        name: 'cluster',
        kind: 'playbook',
        rollbackClass: { kind: 'unsupported', reason: 'the delegated orchestrator decides reversibility' },
        releases: [],
      }),
    }
    registry.register(playbook)

    await expect(engine(registry).rollback('cluster')).rejects.toThrow(RollbackUnsupportedError)
    await expect(engine(registry).rollback('cluster'))
      .rejects.toThrow('the delegated orchestrator decides reversibility')
    await expect(remote.calls()).resolves.toEqual([])
  })
})
