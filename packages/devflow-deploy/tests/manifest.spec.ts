import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManifestError, loadManifest, parseManifest, requireTarget } from '../src/manifest.ts'

const ORIGIN = '/ws/deploy.yml'

function issuesOf(source: string): readonly string[] {
  try {
    parseManifest(source, ORIGIN)
  } catch (error) {
    if (error instanceof ManifestError) return error.issues
    throw error
  }
  throw new Error('expected the manifest to be rejected')
}

describe('parseManifest', () => {
  it('keeps the core fields and hands everything else to the driver', () => {
    const manifest = parseManifest(
      ['targets:', '  landing:', '    kind: static', '    build: pnpm run build', '    dir: dist/', '    entry: index.html'].join('\n'),
      ORIGIN,
    )

    expect(manifest.targets.get('landing')).toEqual({
      kind: 'static',
      build: 'pnpm run build',
      spec: { dir: 'dist/', entry: 'index.html' },
    })
  })

  it('omits build when the target declares none', () => {
    const manifest = parseManifest(['targets:', '  landing:', '    kind: static', '    dir: dist/'].join('\n'), ORIGIN)

    expect(manifest.targets.get('landing')).toEqual({ kind: 'static', spec: { dir: 'dist/' } })
  })

  it('keeps an unknown kind for the registry to reject', () => {
    const manifest = parseManifest(['targets:', '  cluster:', '    kind: playbook', '    command: ansible-playbook site.yml'].join('\n'), ORIGIN)

    expect(manifest.targets.get('cluster')?.kind).toBe('playbook')
  })

  it.each([
    ['a parent-directory escape', '../evil'],
    ['an absolute path', '/etc/nginx'],
    ['an uppercase name', 'Landing'],
    ['a trailing hyphen', 'landing-'],
    ['a leading hyphen', '-landing'],
    ['an underscore', 'land_ing'],
  ])('rejects %s as a target name', (_label, name) => {
    const issues = issuesOf(['targets:', `  ${JSON.stringify(name)}:`, '    kind: static'].join('\n'))

    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('remote paths and public URLs')
  })

  it.each([
    ['landing'],
    ['landing-page'],
    ['a1'],
    ['9'],
  ])('accepts %s as a target name', (name) => {
    const manifest = parseManifest(['targets:', `  ${name}:`, '    kind: static'].join('\n'), ORIGIN)

    expect(manifest.targets.has(name)).toBe(true)
  })

  it('reports every issue rather than stopping at the first', () => {
    const issues = issuesOf(
      ['targets:', '  BAD:', '    kind: static', '  worse:', '    kind: 3', '  worst:', '    kind: static', '    build: \'   \''].join('\n'),
    )

    expect(issues).toHaveLength(3)
    expect(issues[0]).toContain('targets.BAD')
    expect(issues[1]).toContain('targets.worse.kind')
    expect(issues[2]).toContain('targets.worst.build')
  })

  it('rejects a target that is not a mapping', () => {
    expect(issuesOf(['targets:', '  landing: dist/'].join('\n'))[0]).toContain('must be a mapping of target fields')
  })

  it.each([
    ['invalid YAML', 'targets: [', 'is not valid YAML'],
    ['an empty document', '', 'is empty'],
    ['a scalar document', 'nope', 'must be a mapping'],
    ['a missing targets key', 'other: 1', '\'targets\' must be a mapping'],
    ['a targets list', 'targets:\n  - landing', '\'targets\' must be a mapping'],
    ['no targets', 'targets: {}', 'declares no targets'],
  ])('rejects %s', (_label, source, expected) => {
    expect(() => parseManifest(source, ORIGIN)).toThrow(expected)
  })

  it('prefixes the message with each issue when there are any', () => {
    let caught: ManifestError | undefined
    try {
      parseManifest(['targets:', '  BAD:', '    kind: static'].join('\n'), ORIGIN)
    } catch (error) {
      caught = error as ManifestError
    }

    expect(caught?.message).toContain('/ws/deploy.yml is invalid')
    expect(caught?.message).toContain('  - targets.BAD')
  })
})

describe('requireTarget', () => {
  it('names every declared target when the requested one is absent', () => {
    const manifest = parseManifest(['targets:', '  landing:', '    kind: static', '  docs:', '    kind: static'].join('\n'), ORIGIN)

    expect(() => requireTarget(manifest, 'nope')).toThrow('declared targets: landing, docs')
  })

  it('returns the declared target', () => {
    const manifest = parseManifest(['targets:', '  landing:', '    kind: static'].join('\n'), ORIGIN)

    expect(requireTarget(manifest, 'landing').kind).toBe('static')
  })
})

describe('loadManifest', () => {
  it('reads the manifest from the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-manifest-'))
    await writeFile(join(root, 'deploy.yml'), ['targets:', '  landing:', '    kind: static'].join('\n'))

    const manifest = await loadManifest(root, 'deploy.yml')

    expect(manifest.targets.get('landing')?.kind).toBe('static')
  })

  it('reports an unreadable manifest with its resolved path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-manifest-'))

    await expect(loadManifest(root, 'deploy.yml')).rejects.toThrow(join(root, 'deploy.yml'))
  })
})
