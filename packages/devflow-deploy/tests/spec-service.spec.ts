import { describe, expect, it } from 'vitest'
import { ManifestError } from '../src/manifest.ts'
import { validateServiceSpec } from '../src/drivers/service/spec.ts'

const PATH = 'targets.api'

const MINIMAL = { image: 'myapp', service: 'api', ready: { docker: 'health' } }

function issuesOf(spec: unknown): readonly string[] {
  try {
    validateServiceSpec(spec, PATH)
  } catch (error) {
    if (error instanceof ManifestError) return error.issues
    throw error
  }
  throw new Error('expected the spec to be rejected')
}

describe('validateServiceSpec', () => {
  it('defaults the build context to the workspace root', () => {
    expect(validateServiceSpec(MINIMAL, PATH)).toEqual({
      image: 'myapp',
      context: '.',
      service: 'api',
      ready: { kind: 'docker' },
    })
  })

  it('keeps a declared context and dockerfile', () => {
    expect(validateServiceSpec({ ...MINIMAL, context: 'services/api', dockerfile: 'docker/Dockerfile' }, PATH))
      .toMatchObject({ context: 'services/api', dockerfile: 'docker/Dockerfile' })
  })

  it('rejects a spec that is not a mapping', () => {
    expect(issuesOf('myapp')[0]).toContain('must be a mapping of target fields')
  })

  it.each(['image', 'service'])('refuses a missing %s', (field) => {
    expect(issuesOf({ ...MINIMAL, [field]: undefined })[0]).toContain(`targets.api.${field}`)
  })

  it('refuses an image that already carries a tag', () => {
    expect(issuesOf({ ...MINIMAL, image: 'myapp:v1' })[0])
      .toContain('the driver tags each release itself')
  })

  it.each([
    ['an absolute path', '/etc'],
    ['a parent escape', '../outside'],
  ])('refuses %s as the build context', (_label, context) => {
    expect(issuesOf({ ...MINIMAL, context })[0]).toContain('must stay inside the workspace')
  })

  it('refuses a blank context', () => {
    expect(issuesOf({ ...MINIMAL, context: '  ' })[0]).toContain('must name the build context directory')
  })

  it('refuses a dockerfile that leaves the build context', () => {
    expect(issuesOf({ ...MINIMAL, dockerfile: '../Dockerfile' })[0])
      .toContain('must stay inside the build context')
  })

  it('refuses a blank dockerfile', () => {
    expect(issuesOf({ ...MINIMAL, dockerfile: '' })[0]).toContain('must name a Dockerfile')
  })

  it('reports every issue at once', () => {
    expect(issuesOf({ image: 'a:b', context: '/etc' })).toHaveLength(4)
  })
})

describe('the readiness declaration', () => {
  it('accepts an http endpoint', () => {
    expect(validateServiceSpec({ ...MINIMAL, ready: { http: 'http://127.0.0.1:8080/healthz' } }, PATH).ready)
      .toEqual({ kind: 'http', url: 'http://127.0.0.1:8080/healthz' })
  })

  it('accepts a tcp port', () => {
    expect(validateServiceSpec({ ...MINIMAL, ready: { tcp: 8080 } }, PATH).ready)
      .toEqual({ kind: 'tcp', port: 8080 })
  })

  it('accepts the container health check', () => {
    expect(validateServiceSpec({ ...MINIMAL, ready: { docker: 'health' } }, PATH).ready)
      .toEqual({ kind: 'docker' })
  })

  it('is required, and says why', () => {
    const issue = issuesOf({ image: 'myapp', service: 'api' })[0] ?? ''

    expect(issue).toContain('targets.api.ready: required')
    expect(issue).toContain('a target with no check cannot be deployed')
  })

  it.each([
    ['a string', 'healthy'],
    ['an array', []],
  ])('refuses %s as the declaration', (_label, ready) => {
    expect(issuesOf({ ...MINIMAL, ready })[0]).toContain('targets.api.ready: required')
  })

  it('names the supported forms when none is recognised', () => {
    expect(issuesOf({ ...MINIMAL, ready: { grpc: 'x' } })[0])
      .toContain('supported forms are http, tcp, docker')
  })

  it('refuses two forms at once', () => {
    expect(issuesOf({ ...MINIMAL, ready: { tcp: 8080, docker: 'health' } })[0])
      .toContain('exactly one form is allowed')
  })

  it.each([
    ['a bare host', 'example.test'],
    ['a non-http scheme', 'ftp://example.test'],
    ['a number', 8080],
  ])('refuses %s as the http endpoint', (_label, http) => {
    expect(issuesOf({ ...MINIMAL, ready: { http } })[0]).toContain('must be an absolute http(s) URL')
  })

  it.each([
    ['zero', 0],
    ['above the port range', 70_000],
    ['a fraction', 80.5],
    ['a string', '8080'],
  ])('refuses %s as the tcp port', (_label, tcp) => {
    expect(issuesOf({ ...MINIMAL, ready: { tcp } })[0]).toContain('must be a port number between 1 and 65535')
  })

  it('refuses a docker form other than health', () => {
    expect(issuesOf({ ...MINIMAL, ready: { docker: 'running' } })[0])
      .toContain('the only supported value is \'health\'')
  })
})
