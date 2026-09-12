// The layout resolver as observable behavior over real temp directories:
// which manifests produce which member sets, how the supported glob surface
// is bounded, the single-package fallback, the never-throw posture, and the
// manifest-mtime cache. The published service and its disposal are covered
// at the bottom through the plugin's own mount.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Sentinel from '@zhchxiao123/dsh-devflow-spec-sentinel'
import type { DevflowSpecWorkspace, WorkspacePackage } from '../src/types.ts'
import { createWorkspaceLayout, packageGlobs, scopeOf } from '../src/workspace-layout.ts'

let workspace: string | undefined

afterEach(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function tempWorkspace(): Promise<string> {
  workspace = await mkdtemp(join(tmpdir(), 'devflow-layout-'))
  return workspace
}

async function addPackage(root: string, dir: string, name?: string): Promise<string> {
  const packageDir = join(root, dir)
  await mkdir(packageDir, { recursive: true })
  if (name !== undefined) await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name }))
  return packageDir
}

/** A resolver whose warnings are captured through a real logger exporter. */
function resolver(): { layout: DevflowSpecWorkspace['layout']; warnings: string[] } {
  const ctx = new Context()
  const warnings: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      if (message.type === 'warn') warnings.push(message.args.map(String).join(' '))
    },
  })
  const service = createWorkspaceLayout(ctx)
  return { layout: root => service.layout(root), warnings }
}

describe('packageGlobs', () => {
  it('reads the packages list, quoted or not, through comments', () => {
    expect(packageGlobs('# workspace\npackages:\n  - packages/*\n  - "tools/site"\n  - \'!packages/legacy\'\nlinkWorkspacePackages: true\n'))
      .toEqual(['packages/*', 'tools/site', '!packages/legacy'])
  })

  it.each([
    ['unparsable yaml', 'packages: [\n'],
    ['a non-mapping document', 'just a scalar'],
    ['a missing packages key', 'linkWorkspacePackages: true\n'],
    ['a packages key that is not a list', 'packages: all\n'],
    ['a list with a non-string entry', 'packages:\n  - packages/*\n  - {}\n'],
  ])('refuses %s whole', (_label, text) => {
    expect(packageGlobs(text)).toBeUndefined()
  })
})

describe('layout', () => {
  it('expands one-level dir/* globs, keyed by each member package.json name', async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    const alpha = await addPackage(root, 'packages/alpha', '@scope/alpha')
    const beta = await addPackage(root, 'packages/beta', '@scope/beta')
    // A matched directory without a named manifest — absent, non-object, or
    // nameless — is not a workspace package (pnpm's own semantics), and a
    // plain file never matches.
    await addPackage(root, 'packages/not-a-package')
    const scalar = await addPackage(root, 'packages/scalar-manifest')
    await writeFile(join(scalar, 'package.json'), '"just a string"')
    await writeFile(join(root, 'packages/README.md'), 'not a directory\n')

    const { layout, warnings } = resolver()
    expect(await layout(root)).toEqual([
      { dir: alpha, scopeId: '@scope/alpha' },
      { dir: beta, scopeId: '@scope/beta' },
    ])
    expect(warnings).toEqual([])
  })

  it('includes explicit paths and subtracts negated patterns', async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - tools/site\n  - "!packages/legacy"\n')
    const alpha = await addPackage(root, 'packages/alpha', '@scope/alpha')
    await addPackage(root, 'packages/legacy', '@scope/legacy')
    const site = await addPackage(root, 'tools/site', '@scope/site')

    const { layout } = resolver()
    expect(await layout(root)).toEqual([
      { dir: alpha, scopeId: '@scope/alpha' },
      { dir: site, scopeId: '@scope/site' },
    ])
  })

  it('warns on an unsupported glob and skips it, keeping the supported rest', async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/**\n  - tools/site\n')
    await addPackage(root, 'packages/alpha', '@scope/alpha')
    const site = await addPackage(root, 'tools/site', '@scope/site')

    const { layout, warnings } = resolver()
    expect(await layout(root)).toEqual([{ dir: site, scopeId: '@scope/site' }])
    expect(warnings).toEqual([expect.stringContaining('unsupported workspace glob "packages/**"')])
  })

  it('matches nothing under a glob whose parent directory is absent', async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - missing/*\n')
    const { layout, warnings } = resolver()
    expect(await layout(root)).toEqual([])
    expect(warnings).toEqual([])
  })

  it('falls back to a single package rooted at the workspace without pnpm-workspace.yaml', async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@scope/solo' }))
    const { layout, warnings } = resolver()
    expect(await layout(root)).toEqual([{ dir: resolve(root), scopeId: '@scope/solo' }])
    expect(warnings).toEqual([])
  })

  it.each([
    ['an unreadable packages list', async (root: string) => {
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: all\n')
    }],
    ['a root with neither manifest', async (_root: string) => {}],
    ['a nameless single-package root', async (root: string) => {
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }))
    }],
  ])('resolves %s to an empty layout with a warning, never a rejection', async (_label, arrange) => {
    const root = await tempWorkspace()
    await arrange(root)
    const { layout, warnings } = resolver()
    await expect(layout(root)).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('serves the cached layout while the manifest mtime stands, and recomputes when it moves', async () => {
    const root = await tempWorkspace()
    const manifest = join(root, 'pnpm-workspace.yaml')
    await writeFile(manifest, 'packages:\n  - packages/*\n')
    const alphaManifest = join(await addPackage(root, 'packages/alpha', '@scope/alpha'), 'package.json')

    const { layout } = resolver()
    const first = await layout(root)
    expect(first.map((pkg: WorkspacePackage) => pkg.scopeId)).toEqual(['@scope/alpha'])

    // A member rename without a manifest touch is served stale — the cache
    // is keyed on the governing manifest's mtime, not the members'.
    await writeFile(alphaManifest, JSON.stringify({ name: '@scope/renamed' }))
    expect(await layout(root)).toBe(first)

    // Touching the manifest invalidates the entry and picks the rename up.
    await utimes(manifest, new Date(), new Date(Date.now() + 5_000))
    expect((await layout(root)).map((pkg: WorkspacePackage) => pkg.scopeId)).toEqual(['@scope/renamed'])
  })
})

describe('scopeOf', () => {
  const layout: WorkspacePackage[] = [
    { dir: resolve('/ws'), scopeId: '@scope/root' },
    { dir: resolve('/ws/packages/alpha'), scopeId: '@scope/alpha' },
  ]

  it('maps a file to the deepest containing package, whatever the layout order', () => {
    expect(scopeOf(resolve('/ws/packages/alpha/src/a.ts'), layout)).toBe('@scope/alpha')
    expect(scopeOf(resolve('/ws/packages/alpha/src/a.ts'), [...layout].reverse())).toBe('@scope/alpha')
    expect(scopeOf(resolve('/ws/docs/guide.md'), layout)).toBe('@scope/root')
  })

  it('never matches on a bare name prefix, only on a path boundary or the directory itself', () => {
    expect(scopeOf(resolve('/ws/packages/alpha-extras/src/a.ts'), layout.slice(1))).toBeUndefined()
    expect(scopeOf(resolve('/ws/packages/alpha'), layout)).toBe('@scope/alpha')
  })

  it('returns undefined outside every package', () => {
    expect(scopeOf(resolve('/elsewhere/a.ts'), layout)).toBeUndefined()
  })
})

describe('the devflowSpecWorkspace service', () => {
  it('is published by the plugin without the spec seam and unwinds with the fiber', async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@scope/solo' }))
    const ctx = new Context()
    const fork = await ctx.plugin(Sentinel, {})
    await new Promise(tick => setTimeout(tick, 0))

    const service = ctx.get('devflowSpecWorkspace')
    expect(service).toBeDefined()
    expect(await service!.layout(root)).toEqual([{ dir: resolve(root), scopeId: '@scope/solo' }])

    await fork.dispose()
    expect(ctx.get('devflowSpecWorkspace')).toBeUndefined()
  })
})
