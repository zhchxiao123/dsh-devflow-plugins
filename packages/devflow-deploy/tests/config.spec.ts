import { describe, expect, it } from 'vitest'
import { Config, resolveStaticConfig } from '../src/index.ts'

const STATIC = {
  remoteWebRoot: '/srv/www',
  remoteReleasesRoot: '/srv/releases',
  baseUrl: 'https://example.test',
}

function resolved(overrides: Record<string, unknown> = {}): ReturnType<typeof resolveStaticConfig> {
  return resolveStaticConfig({ ...STATIC, ...overrides })
}

describe('Config', () => {
  it('supplies the execution defaults', () => {
    const config = new Config({ host: 'deploy@example.test', drivers: { static: STATIC } })

    expect(config).toMatchObject({
      manifestPath: 'deploy.yml',
      buildTimeoutMs: 600_000,
      remoteTimeoutMs: 120_000,
      logTailBytes: 65_536,
      graceMs: 5_000,
    })
  })

  it('refuses a configuration missing host', () => {
    expect(() => new Config({ drivers: { static: STATIC } })).toThrow()
  })

  it('hands a kind section through without inspecting its shape', () => {
    // The core does not know a kind's config fields, exactly as it does not
    // know its manifest fields; the kind's own resolver reports defects.
    const config = new Config({ host: 'deploy@example.test', drivers: { static: { nonsense: 1 } } })

    expect(config.drivers['static']).toEqual({ nonsense: 1 })
  })

  it('defaults to no configured kinds, which apply then rejects', () => {
    expect(new Config({ host: 'deploy@example.test' }).drivers).toEqual({})
  })
})

describe('resolveStaticConfig', () => {
  it('applies the retention default', () => {
    expect(resolved().keepReleases).toBe(5)
  })

  it('keeps a declared retention window', () => {
    expect(resolved({ keepReleases: 2 }).keepReleases).toBe(2)
  })

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
    ['a string', 'srv'],
    ['an array', []],
    ['null', null],
  ])('refuses a section that is %s', (_label, raw) => {
    expect(() => resolveStaticConfig(raw)).toThrow('must be a mapping')
  })

  it.each(['remoteWebRoot', 'remoteReleasesRoot', 'baseUrl'])('refuses a missing %s', (field) => {
    expect(() => resolveStaticConfig({ ...STATIC, [field]: undefined }))
      .toThrow(`drivers.static.${field} must be a non-empty string`)
  })

  it.each(['remoteWebRoot', 'remoteReleasesRoot', 'baseUrl'])('refuses a blank %s', (field) => {
    expect(() => resolveStaticConfig({ ...STATIC, [field]: '   ' }))
      .toThrow(`drivers.static.${field} must be a non-empty string`)
  })

  it.each([
    ['remoteWebRoot', { remoteWebRoot: 'srv/www' }],
    ['remoteReleasesRoot', { remoteReleasesRoot: 'releases' }],
  ])('refuses a relative %s', (field, overrides) => {
    expect(() => resolved(overrides)).toThrow(`drivers.static.${field} must be an absolute path`)
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

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['a string', '5'],
  ])('refuses %s as the retention window', (_label, keepReleases) => {
    expect(() => resolved({ keepReleases })).toThrow('must be a positive integer')
  })
})
