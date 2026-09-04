import { describe, expect, it } from 'vitest'
import { Config, resolveAddresses } from '../src/index.ts'

const VALID = {
  host: 'deploy@example.test',
  remoteWebRoot: '/srv/www',
  remoteReleasesRoot: '/srv/releases',
  baseUrl: 'https://example.test',
}

function resolved(overrides: Partial<typeof VALID> = {}): ReturnType<typeof resolveAddresses> {
  return resolveAddresses(new Config({ ...VALID, ...overrides }))
}

describe('Config', () => {
  it('supplies the execution defaults', () => {
    const config = new Config(VALID)

    expect(config).toMatchObject({
      manifestPath: 'deploy.yml',
      keepReleases: 5,
      buildTimeoutMs: 600_000,
      remoteTimeoutMs: 120_000,
      logTailBytes: 65_536,
      graceMs: 5_000,
    })
  })

  it.each([
    ['host', { remoteWebRoot: VALID.remoteWebRoot, remoteReleasesRoot: VALID.remoteReleasesRoot, baseUrl: VALID.baseUrl }],
    ['remoteWebRoot', { host: VALID.host, remoteReleasesRoot: VALID.remoteReleasesRoot, baseUrl: VALID.baseUrl }],
    ['remoteReleasesRoot', { host: VALID.host, remoteWebRoot: VALID.remoteWebRoot, baseUrl: VALID.baseUrl }],
    ['baseUrl', { host: VALID.host, remoteWebRoot: VALID.remoteWebRoot, remoteReleasesRoot: VALID.remoteReleasesRoot }],
  ])('refuses a configuration missing %s', (_field, partial) => {
    expect(() => new Config(partial)).toThrow()
  })
})

describe('resolveAddresses', () => {
  it('normalises trailing slashes', () => {
    expect(resolved({ remoteWebRoot: '/srv/www/', remoteReleasesRoot: '/srv/releases//', baseUrl: 'https://example.test/' }))
      .toMatchObject({
        remoteWebRoot: '/srv/www',
        remoteReleasesRoot: '/srv/releases',
        baseUrl: 'https://example.test',
      })
  })

  it('keeps the root path itself addressable', () => {
    expect(resolved({ remoteWebRoot: '/', remoteReleasesRoot: '/releases' }).remoteWebRoot).toBe('/')
  })

  it.each([
    ['remoteWebRoot', { remoteWebRoot: 'srv/www' }],
    ['remoteReleasesRoot', { remoteReleasesRoot: 'releases' }],
  ])('refuses a relative %s', (field, overrides) => {
    expect(() => resolved(overrides)).toThrow(`${field} must be an absolute path`)
  })

  it.each([
    ['a bare host', 'example.test'],
    ['a non-http scheme', 'ftp://example.test'],
    ['an empty authority', 'https://'],
  ])('refuses %s as the base URL', (_label, baseUrl) => {
    expect(() => resolved({ baseUrl })).toThrow('must be an absolute http(s) URL')
  })

  it('accepts a plain http base URL', () => {
    expect(resolved({ baseUrl: 'http://example.test' }).baseUrl).toBe('http://example.test')
  })

  it.each([
    ['the same directory', '/srv/www'],
    ['a subdirectory', '/srv/www/releases'],
    ['a subdirectory reached with a trailing slash', '/srv/www/releases/'],
  ])('refuses a releases root that is %s of the served tree', (_label, remoteReleasesRoot) => {
    expect(() => resolved({ remoteReleasesRoot })).toThrow('must sit outside remoteWebRoot')
  })

  it('allows a sibling whose name merely starts the same way', () => {
    expect(resolved({ remoteWebRoot: '/srv/www', remoteReleasesRoot: '/srv/www-releases' }).remoteReleasesRoot)
      .toBe('/srv/www-releases')
  })
})
