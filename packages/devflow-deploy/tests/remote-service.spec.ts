import { describe, expect, it } from 'vitest'
import {
  composeUpArgv,
  containerIdArgv,
  dockerBuildArgv,
  dockerLoadArgv,
  dockerSaveArgv,
  dockerVersionArgv,
  envPath,
  healthArgv,
  imageInspectArgv,
  imageRef,
  imageRemoveArgv,
  imageTagsArgv,
  readComposeArgv,
  readEnvArgv,
  remoteTarPath,
  removeRemoteFileArgv,
  sendArchiveArgv,
  writeEnvArgv,
} from '../src/drivers/service/remote.ts'

const HOST = 'deploy@example.test'
const COMPOSE = '/opt/app'
const TMP = '/tmp'
const ID = '20260903T194507Z'

/** The command an ssh argv carries. */
function command(argv: readonly string[]): string {
  return argv[4] ?? ''
}

describe('the version and its pointer', () => {
  it('tags a release on the image repository', () => {
    expect(imageRef('myapp', ID)).toBe('myapp:20260903T194507Z')
  })

  it('names the pointer file inside the compose project', () => {
    expect(envPath('/opt/app/')).toBe('/opt/app/.env')
  })

  it('keeps a namespaced image name usable as a filename', () => {
    expect(remoteTarPath(TMP, 'team/myapp', ID)).toBe('/tmp/team_myapp-20260903T194507Z.tar')
  })
})

describe('local commands', () => {
  it('builds the release image from the declared context', () => {
    expect(dockerBuildArgv('myapp', ID, '.', undefined))
      .toEqual(['docker', 'build', '-t', 'myapp:20260903T194507Z', '.'])
  })

  it('passes a declared dockerfile through', () => {
    expect(dockerBuildArgv('myapp', ID, 'services/api', 'docker/Dockerfile'))
      .toEqual(['docker', 'build', '-t', 'myapp:20260903T194507Z', '-f', 'docker/Dockerfile', 'services/api'])
  })

  it('proves the built image exists', () => {
    expect(imageInspectArgv('myapp', ID)).toEqual(['docker', 'image', 'inspect', 'myapp:20260903T194507Z'])
  })

  it('writes the image to an archive rather than piping it', () => {
    const argv = dockerSaveArgv('myapp', ID, '/tmp/out.tar')

    expect(argv).toEqual(['docker', 'save', 'myapp:20260903T194507Z', '-o', '/tmp/out.tar'])
    expect(argv.join(' ')).not.toContain('|')
  })

  it('compresses the archive in transit', () => {
    expect(sendArchiveArgv('/tmp/out.tar', HOST, '/tmp/in.tar'))
      .toEqual(['rsync', '-z', '/tmp/out.tar', 'deploy@example.test:/tmp/in.tar'])
  })
})

describe('remote commands', () => {
  it('loads the transferred archive', () => {
    expect(command(dockerLoadArgv(HOST, '/tmp/in.tar'))).toBe('docker load -i \'/tmp/in.tar\'')
  })

  it('proves the host can run docker', () => {
    expect(command(dockerVersionArgv(HOST))).toBe('docker version --format {{.Server.Version}}')
  })

  it('reads either compose filename without failing when neither exists', () => {
    const cmd = command(readComposeArgv(HOST, COMPOSE))

    expect(cmd).toContain('cat \'/opt/app\'/docker-compose.yml')
    expect(cmd).toContain('cat \'/opt/app\'/compose.yml')
    expect(cmd.endsWith('|| true')).toBe(true)
  })

  it('reads the pointer without failing when nothing is deployed', () => {
    expect(command(readEnvArgv(HOST, COMPOSE))).toBe('cat \'/opt/app/.env\' 2>/dev/null || true')
  })

  it('writes the pointer with printf rather than echo', () => {
    const cmd = command(writeEnvArgv(HOST, COMPOSE, 'APP_IMAGE_TAG=v1\nOTHER=2\n'))

    expect(cmd).toBe('printf %s \'APP_IMAGE_TAG=v1\nOTHER=2\n\' > \'/opt/app/.env\'')
    expect(cmd).not.toContain('echo')
  })

  it('brings the service up from inside the compose project', () => {
    expect(command(composeUpArgv(HOST, COMPOSE, 'api')))
      .toBe('cd \'/opt/app\' && docker compose up -d \'api\'')
  })

  it('reads the container id without failing when the service is down', () => {
    expect(command(containerIdArgv(HOST, COMPOSE, 'api')))
      .toBe('cd \'/opt/app\' && docker compose ps -q \'api\' 2>/dev/null || true')
  })

  it('reports none when the image declares no health check', () => {
    expect(command(healthArgv(HOST, 'abc123')))
      .toBe('docker inspect --format {{.State.Health.Status}} \'abc123\' 2>/dev/null || echo none')
  })

  it('lists the release tags in name order', () => {
    expect(command(imageTagsArgv(HOST, 'myapp')))
      .toBe('docker image ls \'myapp\' --format {{.Tag}} 2>/dev/null | sort || true')
  })

  it('removes every superseded image in one command', () => {
    expect(command(imageRemoveArgv(HOST, 'myapp', ['a', 'b'])))
      .toBe('docker image rm \'myapp:a\' \'myapp:b\'')
  })

  it('deletes the transferred archive', () => {
    expect(command(removeRemoteFileArgv(HOST, '/tmp/in.tar'))).toBe('rm -f \'/tmp/in.tar\'')
  })
})

describe('defence in depth against a hostile value', () => {
  // The manifest and the config already vet these; the quoting must hold
  // anyway, because a driver is one refactor away from a value nothing vetted.
  it.each([
    ['a compose directory', () => command(composeUpArgv(HOST, '/opt/$(id)', 'api'))],
    ['a service name', () => command(composeUpArgv(HOST, COMPOSE, 'a; rm -rf /'))],
    ['an image name', () => command(imageRemoveArgv(HOST, '`id`', [ID]))],
    ['a container id', () => command(healthArgv(HOST, 'a\'; rm -rf /; \''))],
    ['env contents', () => command(writeEnvArgv(HOST, COMPOSE, '$(id)\n'))],
  ])('keeps %s inside one quoted argument', (_label, build) => {
    const cmd = build()

    // Every quote opens or closes; an unbalanced count would mean a value
    // escaped its quoting.
    expect((cmd.match(/'/g) ?? []).length % 2).toBe(0)
  })
})
