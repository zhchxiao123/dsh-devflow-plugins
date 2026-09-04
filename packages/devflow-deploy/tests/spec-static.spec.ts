import { describe, expect, it } from 'vitest'
import { ManifestError } from '../src/manifest.ts'
import { DEFAULT_ENTRY, validateStaticSpec } from '../src/drivers/static/spec.ts'

const PATH = 'targets.landing'

function issuesOf(spec: unknown): readonly string[] {
  try {
    validateStaticSpec(spec, PATH)
  } catch (error) {
    if (error instanceof ManifestError) return error.issues
    throw error
  }
  throw new Error('expected the spec to be rejected')
}

describe('validateStaticSpec', () => {
  it('applies the default entry document', () => {
    expect(validateStaticSpec({ dir: 'dist' }, PATH)).toEqual({ dir: 'dist', entry: DEFAULT_ENTRY })
  })

  it('keeps a declared entry document', () => {
    expect(validateStaticSpec({ dir: 'dist', entry: 'home.html' }, PATH))
      .toEqual({ dir: 'dist', entry: 'home.html' })
  })

  it('accepts a nested artifact directory', () => {
    expect(validateStaticSpec({ dir: 'build/site/' }, PATH).dir).toBe('build/site/')
  })

  it('accepts a path that dips into a subdirectory and back', () => {
    expect(validateStaticSpec({ dir: 'build/../dist' }, PATH).dir).toBe('build/../dist')
  })

  it('rejects a spec that is not a mapping', () => {
    expect(issuesOf('dist')[0]).toContain('must be a mapping of target fields')
  })

  it.each([
    ['a missing dir', {}],
    ['a non-string dir', { dir: 3 }],
    ['a blank dir', { dir: '   ' }],
  ])('rejects %s', (_label, spec) => {
    expect(issuesOf(spec)[0]).toContain('targets.landing.dir')
  })

  it.each([
    ['an absolute path', '/srv/www'],
    ['a parent escape', '../outside'],
    ['a deep escape', 'dist/../../outside'],
  ])('rejects %s as the artifact directory', (_label, dir) => {
    expect(issuesOf({ dir })[0]).toContain('must stay inside the workspace')
  })

  it.each([
    ['a non-string entry', 3],
    ['a blank entry', '  '],
  ])('rejects %s', (_label, entry) => {
    expect(issuesOf({ dir: 'dist', entry })[0]).toContain('targets.landing.entry')
  })

  it('rejects an entry that leaves the artifact directory', () => {
    expect(issuesOf({ dir: 'dist', entry: '../secret' })[0])
      .toContain('must stay inside the artifact directory')
  })

  it('reports every issue at once', () => {
    expect(issuesOf({ dir: '/srv', entry: '../x' })).toHaveLength(2)
  })
})
