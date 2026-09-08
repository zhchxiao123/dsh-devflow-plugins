import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServiceDriver, prunableImages } from '../src/drivers/service/driver.ts'
import { DeployFailure, DeployRunContext } from '../src/run.ts'
import type { ResolvedTarget } from '../src/types.ts'
import type { ServiceSpec } from '../src/drivers/service/spec.ts'
import { createDockerDouble, useDockerPath } from './docker-double.ts'
import type { DockerDouble } from './docker-double.ts'

const HOST = 'deploy@example.test'
const TARGET: ResolvedTarget<ServiceSpec> = {
  name: 'api',
  spec: { image: 'myapp', context: '.', service: 'api', ready: { kind: 'docker' } },
}

let docker: DockerDouble
let root: string
let ctx: Context
let dispose: () => void
let restorePath: () => void
let tick = 0

beforeEach(async () => {
  docker = await createDockerDouble()
  root = await mkdtemp(join(tmpdir(), 'deploy-svc-ws-'))
  ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  dispose = (): void => {
    void fiber.dispose()
  }
  restorePath = useDockerPath(docker)
  tick = 0
})

afterEach(() => {
  dispose()
  restorePath()
})

function run(): DeployRunContext {
  return new DeployRunContext(ctx, {
    root,
    buildTimeoutMs: 20_000,
    remoteTimeoutMs: 20_000,
    logTailBytes: 65_536,
    graceMs: 1_000,
    clock: () => new Date(Date.UTC(2026, 8, 3, 19, tick++, 0)),
  })
}

function driver(overrides: { keepImages?: number } = {}) {
  return createServiceDriver({
    host: HOST,
    composeDir: docker.remoteComposeDir,
    tagVarName: 'APP_IMAGE_TAG',
    remoteTmpDir: docker.remoteTmpDir,
    keepImages: overrides.keepImages ?? 5,
    verifyTimeoutMs: 300,
    readyPollIntervalMs: 20,
  })
}

async function deploy() {
  return driver().deploy(run(), TARGET)
}

describe('deploying a service', () => {
  it('builds, ships, switches, and leaves the container on the new tag', async () => {
    const outcome = await deploy()

    expect(await docker.running()).toBe(outcome.releaseId)
    expect(await docker.env()).toContain(`APP_IMAGE_TAG=${outcome.releaseId}`)
  })

  it('transfers the image as an archive rather than a pipe', async () => {
    await deploy()

    const calls = await docker.calls()
    expect(calls.some(call => call.startsWith('docker save'))).toBe(true)
    expect(calls.some(call => call.startsWith('rsync'))).toBe(true)
    expect(calls.some(call => call.includes('docker load'))).toBe(true)
    // Save and load are separate commands, never one pipe: `pipefail` is not
    // POSIX, so a pipe would report only the last command's exit status.
    expect(calls.every(call => !(call.includes('docker save') && call.includes('docker load')))).toBe(true)
  })

  it('removes both temporary archives', async () => {
    const outcome = await deploy()

    const local = join(tmpdir(), `myapp-${outcome.releaseId}.tar`)
    await expect(readFile(local, 'utf8')).rejects.toThrow()
    expect((await docker.calls()).some(call => call.includes('rm -f'))).toBe(true)
  })

  it('keeps the operator\'s own variables in .env', async () => {
    await writeFile(join(docker.composeDir, '.env'), 'DB_PASSWORD=hunter2\nPORT=8080\n')

    await deploy()

    const env = await docker.env()
    expect(env).toContain('DB_PASSWORD=hunter2')
    expect(env).toContain('PORT=8080')
  })
})

describe('the preflight boundary', () => {
  it('refuses when the image build fails, before anything remote happens', async () => {
    process.env['DOCKER_FAKE_FAIL'] = 'build'

    await expect(deploy()).rejects.toThrow(DeployFailure)

    expect((await docker.calls()).some(call => call.startsWith('ssh'))).toBe(false)
    expect(await docker.running()).toBeUndefined()
  })

  it('refuses when the host cannot run docker, without touching the container', async () => {
    process.env['DOCKER_FAKE_FAIL'] = 'version'

    let caught: DeployFailure | undefined
    try {
      await deploy()
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.phase).toBe('preflight')
    expect(await docker.env()).toBe('')
  })

  it('refuses a compose project that never references the tag variable', async () => {
    const other = await createDockerDouble('image: myapp:latest\n')
    const restore = useDockerPath(other)
    try {
      const bespoke = createServiceDriver({
        host: HOST,
        composeDir: other.composeDir,
        tagVarName: 'APP_IMAGE_TAG',
        remoteTmpDir: join(other.storeDir, 'tmp'),
        keepImages: 5,
        verifyTimeoutMs: 300,
        readyPollIntervalMs: 20,
      })

      await expect(bespoke.deploy(run(), TARGET)).rejects.toThrow(/never references \$\{APP_IMAGE_TAG\}/)
      expect(await other.env()).toBe('')
    } finally {
      restore()
    }
  })
})

describe('when the new release does not come up', () => {
  it('retreats to the previous release and reports it healthy', async () => {
    const first = await deploy()
    process.env['DOCKER_FAKE_FAIL_TAG'] = '20260903T190100Z'

    let caught: DeployFailure | undefined
    try {
      await deploy()
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.message).toContain('did not come up')
    expect(caught?.message).toContain(`the previous release ${first.releaseId} was restored and is healthy`)
    expect(await docker.running()).toBe(first.releaseId)
  })

  it('reports the service down when the retreat itself does not come back healthy', async () => {
    const first = await deploy()
    process.env['DOCKER_FAKE_UNHEALTHY_TAG'] = first.releaseId
    process.env['DOCKER_FAKE_FAIL_TAG'] = '20260903T190100Z'

    let caught: DeployFailure | undefined
    try {
      await deploy()
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.phase).toBe('verify')
    expect(caught?.message).toContain('IS NOT HEALTHY')
    expect(caught?.message).toContain('needs attention')
  })

  it('says there was nothing to return to on a first deploy', async () => {
    process.env['DOCKER_FAKE_FAIL'] = 'up'

    let caught: DeployFailure | undefined
    try {
      await deploy()
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.message).toContain('there was no previous release to return to')
    expect(caught?.message).not.toContain('IS NOT HEALTHY')
  })

  it('fails verification when the container never reports healthy', async () => {
    process.env['DOCKER_FAKE_UNHEALTHY_TAG'] = '20260903T190000Z'

    await expect(deploy()).rejects.toThrow(/reports health 'unhealthy'/)
  })
})

describe('status', () => {
  it('reports nothing deployed before the first deploy', async () => {
    const status = await driver().status(run(), TARGET)

    expect(status.name).toBe('api')
    expect(status.kind).toBe('service')
    expect(status.rollbackClass.kind).toBe('disruptive')
    expect(status.releases).toEqual([])
  })

  it('reports the current release newest first', async () => {
    const first = await deploy()
    const second = await deploy()

    const status = await driver().status(run(), TARGET)

    expect(status.currentRelease).toBe(second.releaseId)
    expect(status.releases.map(release => release.id)).toEqual([second.releaseId, first.releaseId])
  })

  it('carries no address, because a container kind has none', async () => {
    await deploy()

    expect((await driver().status(run(), TARGET)).url).toBeUndefined()
  })
})

describe('rollback', () => {
  it('returns to the previous release without rebuilding', async () => {
    const first = await deploy()
    await deploy()
    const before = (await docker.calls()).filter(call => call.startsWith('docker build')).length

    const outcome = await driver().rollback?.(run(), TARGET)

    expect(outcome?.releaseId).toBe(first.releaseId)
    expect(await docker.running()).toBe(first.releaseId)
    expect((await docker.calls()).filter(call => call.startsWith('docker build'))).toHaveLength(before)
  })

  it('does not retreat again when the rollback itself fails to come up', async () => {
    const first = await deploy()
    await deploy()
    process.env['DOCKER_FAKE_UNHEALTHY_TAG'] = first.releaseId

    await expect(driver().rollback?.(run(), TARGET))
      .rejects.toThrow(/no further switch was attempted/)
  })

  it('names the available releases when the requested one does not exist', async () => {
    await deploy()

    await expect(driver().rollback?.(run(), TARGET, 'nope')).rejects.toThrow(/has no release 'nope'/)
  })

  it('refuses when the target has never been deployed', async () => {
    await expect(driver().rollback?.(run(), TARGET)).rejects.toThrow(/no releases to roll back to/)
  })

  it('refuses when the current release is the only one', async () => {
    await deploy()

    await expect(driver().rollback?.(run(), TARGET)).rejects.toThrow(/oldest release/)
  })
})

describe('prunableImages', () => {
  it('keeps the retention window', () => {
    expect(prunableImages(['a', 'b', 'c', 'd'], 'd', 2)).toEqual(['a', 'b'])
  })

  it('never removes the current release or the rollback target', () => {
    expect(prunableImages(['a', 'b', 'c', 'd'], 'b', 1)).toEqual(['c'])
  })

  it('keeps the window when nothing is deployed', () => {
    expect(prunableImages(['a', 'b', 'c'], undefined, 2)).toEqual(['a'])
  })
})

describe('pruning during a deploy', () => {
  it('removes superseded images past the window', async () => {
    const first = await driver({ keepImages: 1 }).deploy(run(), TARGET)
    await driver({ keepImages: 1 }).deploy(run(), TARGET)
    await driver({ keepImages: 1 }).deploy(run(), TARGET)

    const status = await driver().status(run(), TARGET)
    expect(status.releases.map(release => release.id)).not.toContain(first.releaseId)
  })

  it('warns rather than fails when a superseded image cannot be removed', async () => {
    await driver({ keepImages: 1 }).deploy(run(), TARGET)
    await driver({ keepImages: 1 }).deploy(run(), TARGET)
    process.env['DOCKER_FAKE_FAIL'] = 'rm'
    const third = run()

    await expect(driver({ keepImages: 1 }).deploy(third, TARGET)).resolves.toHaveProperty('releaseId')
    expect(third.recordedWarnings().join(' ')).toContain('could not be removed')
  })
})

describe('readiness forms other than the container health check', () => {
  function withReady(ready: ServiceSpec['ready']): ResolvedTarget<ServiceSpec> {
    return { name: 'api', spec: { ...TARGET.spec, ready } }
  }

  it('accepts an http endpoint that answers', async () => {
    await expect(driver().deploy(run(), withReady({ kind: 'http', url: 'http://127.0.0.1:9/ok' })))
      .resolves.toHaveProperty('releaseId')
  })

  it('reports the endpoint that never answered', async () => {
    process.env['DOCKER_FAKE_CURL_FAIL'] = '1'

    await expect(driver().deploy(run(), withReady({ kind: 'http', url: 'http://127.0.0.1:9/ok' })))
      .rejects.toThrow(/did not answer/)
  })

  it('accepts a tcp port that accepts a connection', async () => {
    await expect(driver().deploy(run(), withReady({ kind: 'tcp', port: 8080 })))
      .resolves.toHaveProperty('releaseId')
  })

  it('reports the port nothing listened on', async () => {
    process.env['DOCKER_FAKE_TCP_FAIL'] = '1'

    await expect(driver().deploy(run(), withReady({ kind: 'tcp', port: 8080 })))
      .rejects.toThrow(/nothing accepted a connection on port 8080/)
  })

  it('says so when the image declares no health check', async () => {
    process.env['DOCKER_FAKE_NO_HEALTHCHECK'] = '1'

    await expect(deploy()).rejects.toThrow(/declares no HEALTHCHECK/)
  })
})

describe('failures around the retreat itself', () => {
  it('reports the service down when the retreat command fails outright', async () => {
    const first = await deploy()
    // Every `up` now fails: the new release cannot start, and neither can the
    // retreat, which is the worst case the report has to name honestly.
    process.env['DOCKER_FAKE_FAIL'] = 'up'

    let caught: DeployFailure | undefined
    try {
      await deploy()
    } catch (error) {
      caught = error as DeployFailure
    }

    expect(caught?.phase).toBe('verify')
    expect(caught?.message).toContain(`the previous release ${first.releaseId} was restored but IS NOT HEALTHY`)
  })

  it('refuses a compose project with no compose file at all', async () => {
    const { rm: removeFile } = await import('node:fs/promises')
    await removeFile(join(docker.composeDir, 'docker-compose.yml'))

    await expect(deploy()).rejects.toThrow(/no compose file was found/)
  })

  it('warns rather than fails when the local archive cannot be removed', async () => {
    const { mkdir: makeDir, rm: removeAll } = await import('node:fs/promises')
    // A directory where the archive belongs makes the driver's `rm` of a file
    // fail, which is the only way this cleanup realistically goes wrong.
    const archive = join(tmpdir(), 'myapp-20260903T190000Z.tar')
    await removeAll(archive, { recursive: true, force: true })
    await makeDir(archive, { recursive: true })
    const call = run()

    try {
      await expect(driver().deploy(call, TARGET)).rejects.toThrow()
      expect(call.recordedWarnings().join(' ')).toContain('could not be removed')
    } finally {
      await removeAll(archive, { recursive: true, force: true })
    }
  })
})

describe('build inputs', () => {
  it('passes a declared dockerfile to the build', async () => {
    const { mkdir: makeDir, writeFile: write } = await import('node:fs/promises')
    await makeDir(join(root, 'docker'), { recursive: true })
    await write(join(root, 'docker', 'Dockerfile'), 'FROM scratch\n')

    await driver().deploy(run(), {
      name: 'api',
      spec: { ...TARGET.spec, dockerfile: 'docker/Dockerfile' },
    })

    expect((await docker.calls()).some(call => call.includes('-f docker/Dockerfile'))).toBe(true)
  })

  it('ignores an untagged image row when listing releases', async () => {
    await deploy()
    const { writeFile: write } = await import('node:fs/promises')
    await write(join(docker.storeDir, 'images', 'myapp_<none>'), 'built\n')

    const status = await driver().status(run(), TARGET)

    expect(status.releases.map(release => release.id)).not.toContain('<none>')
  })
})

describe('the remaining edges', () => {
  it('rolls back to the newest release when the pointer has been lost', async () => {
    await deploy()
    const second = await deploy()
    const { writeFile: write } = await import('node:fs/promises')
    await write(join(docker.composeDir, '.env'), 'PORT=8080\n')

    await expect(driver().rollback?.(run(), TARGET)).resolves.toHaveProperty('releaseId', second.releaseId)
  })

  it('reports that the compose service has no container at all', async () => {
    process.env['DOCKER_FAKE_NO_CONTAINER'] = '1'

    await expect(deploy()).rejects.toThrow(/no running container/)
  })

  it('warns rather than fails when the transferred archive cannot be removed', async () => {
    process.env['DOCKER_FAKE_RMFILE_FAIL'] = '1'
    const call = run()

    await expect(driver().deploy(call, TARGET)).resolves.toHaveProperty('releaseId')
    expect(call.recordedWarnings().join(' ')).toContain('could not be removed from')
  })
})
