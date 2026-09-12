/**
 * Workspace layout resolver: from one workspace root to its member packages
 * and their scope ids, mechanically, so scope coverage never depends on a
 * hand-maintained list. `pnpm-workspace.yaml`'s `packages` globs name the
 * members; each member's `package.json` name is its scope id; a workspace
 * without `pnpm-workspace.yaml` is a single package rooted at the workspace
 * itself.
 *
 * The glob expansion is deliberately minimal, with the supported surface
 * stated at the function rather than delegated to a glob dependency this
 * package would carry for one pattern shape. Anything outside that surface —
 * and any unreadable manifest — degrades to an empty layout plus a logged
 * warning: every consumer sits on a model-facing path, so resolution failure
 * is never allowed to fail a step.
 * @module @zhchxiao123/dsh-devflow-spec-sentinel/src/workspace-layout
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'
import type { DevflowSpecWorkspace, WorkspacePackage } from './types.ts'

/**
 * Extract the `packages` globs of a `pnpm-workspace.yaml`.
 * @param text - the manifest contents.
 * @returns the glob list, or `undefined` when the manifest does not parse or
 *   its `packages` key is not a list of strings — a half-read manifest would
 *   misreport the member set, so an ill-formed one is refused whole.
 */
export function packageGlobs(text: string): string[] | undefined {
  let manifest: unknown
  try {
    manifest = parseYaml(text)
  } catch {
    // Not YAML at all; the caller warns with the manifest path.
    return undefined
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const packages = (manifest as { packages?: unknown }).packages
  if (!Array.isArray(packages) || !packages.every((entry): entry is string => typeof entry === 'string')) return undefined
  return packages
}

/**
 * Expand one glob pattern to candidate directories.
 *
 * Supported surface: an explicit relative path (no `*`), or a one-level
 * directory wildcard ending in `/*` (`packages/*`). `**`, mid-path or bare
 * `*`, and every other glob feature are unsupported and expand to nothing
 * after a warning — a silently narrowed layout would misreport coverage.
 * @param root - absolute workspace root.
 * @param pattern - one pattern, negation already stripped by the caller.
 * @param warn - sink for the unsupported-pattern warning.
 * @returns absolute candidate directories; membership is decided later by
 *   each candidate's `package.json`.
 */
async function expandPattern(root: string, pattern: string, warn: (message: string) => void): Promise<string[]> {
  if (pattern.endsWith('/*')) {
    const parent = join(root, pattern.slice(0, -2))
    let entries
    try {
      entries = await readdir(parent, { withFileTypes: true })
    } catch {
      // An absent parent directory matches nothing; pnpm treats it the same way.
      return []
    }
    return entries.filter(entry => entry.isDirectory()).map(entry => join(parent, entry.name))
  }
  if (pattern.includes('*')) {
    warn(`devflow-spec-sentinel: unsupported workspace glob "${pattern}"`
      + ' (only explicit paths and one-level "dir/*" are read); its matches are not in the layout')
    return []
  }
  return [join(root, pattern)]
}

/**
 * Read one candidate directory's package name.
 * @param dir - absolute candidate directory.
 * @returns the `package.json` name, or `undefined` when the directory has no
 *   readable, named manifest — which per pnpm's own semantics means it is not
 *   a workspace package, not that resolution failed.
 */
async function packageName(dir: string): Promise<string | undefined> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    // Unreadable or unparsable manifest: the directory merely matched a glob.
    return undefined
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const name = (manifest as { name?: unknown }).name
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined
}

/**
 * Compute one root's layout, uncached.
 * @param root - absolute workspace root.
 * @param globs - the manifest's patterns, or `undefined` for the
 *   single-package fallback (no `pnpm-workspace.yaml`).
 * @param warn - sink for pattern and fallback warnings.
 * @returns the member packages, ordered by directory for a deterministic
 *   layout; `undefined` after a warned fallback failure, which the caller
 *   must not cache.
 */
async function computeLayout(
  root: string,
  globs: readonly string[] | undefined,
  warn: (message: string) => void,
): Promise<WorkspacePackage[] | undefined> {
  if (globs === undefined) {
    const name = await packageName(root)
    if (name === undefined) {
      warn(`devflow-spec-sentinel: ${root} has neither pnpm-workspace.yaml nor a named package.json; workspace layout is empty`)
      return undefined
    }
    return [{ dir: root, scopeId: name }]
  }
  const included = new Set<string>()
  const excluded = new Set<string>()
  for (const pattern of globs) {
    const negated = pattern.startsWith('!')
    const target = negated ? excluded : included
    for (const dir of await expandPattern(root, negated ? pattern.slice(1) : pattern, warn)) target.add(dir)
  }
  const packages: WorkspacePackage[] = []
  for (const dir of [...included].filter(dir => !excluded.has(dir)).sort()) {
    const name = await packageName(dir)
    if (name !== undefined) packages.push({ dir, scopeId: name })
  }
  return packages
}

/** One cached resolution, valid while its manifest file's mtime stands. */
interface LayoutCacheEntry {
  readonly manifest: string
  readonly mtimeMs: number
  readonly layout: readonly WorkspacePackage[]
}

/**
 * Build the `devflowSpecWorkspace` service value.
 *
 * Results are cached per root and validated by the governing manifest's mtime
 * (`pnpm-workspace.yaml`, or the root `package.json` for a single-package
 * workspace) — the same stat-keyed shape as the spec provider's anchor-source
 * parse cache, chosen over the board snapshot's recompute-every-step because
 * one layout read fans out to a `package.json` per member, and the manifest's
 * mtime answers "did the member set change" exactly. A member renamed without
 * a manifest touch is served stale until the manifest changes; renaming a
 * package is repository surgery, not a per-step event. Failed resolutions are
 * never cached, so a repaired workspace recovers on the next call.
 * @param ctx - context supplying the warning logger.
 * @returns the service value.
 */
export function createWorkspaceLayout(ctx: Context): DevflowSpecWorkspace {
  const cache = new Map<string, LayoutCacheEntry>()
  const warn = (message: string): void => { ctx.logger.warn(message) }
  return {
    async layout(root: string): Promise<readonly WorkspacePackage[]> {
      const resolvedRoot = resolve(root)
      try {
        const workspaceManifest = join(resolvedRoot, 'pnpm-workspace.yaml')
        let manifest = workspaceManifest
        let stats
        try {
          stats = await stat(workspaceManifest)
        } catch {
          // No pnpm-workspace.yaml: single-package fallback, governed by the
          // root package.json. Its absence falls through to the outer catch.
          manifest = join(resolvedRoot, 'package.json')
          stats = await stat(manifest)
        }
        const cached = cache.get(resolvedRoot)
        if (cached !== undefined && cached.manifest === manifest && cached.mtimeMs === stats.mtimeMs) {
          return cached.layout
        }
        let globs: string[] | undefined
        if (manifest === workspaceManifest) {
          globs = packageGlobs(await readFile(manifest, 'utf8'))
          if (globs === undefined) {
            warn(`devflow-spec-sentinel: ${manifest} carries no readable "packages" list; workspace layout is empty`)
            return []
          }
        }
        const layout = await computeLayout(resolvedRoot, globs, warn)
        if (layout === undefined) return []
        cache.set(resolvedRoot, { manifest, mtimeMs: stats.mtimeMs, layout })
        return layout
      } catch (error) {
        warn(`devflow-spec-sentinel: workspace layout resolution failed for ${resolvedRoot}: ${String(error)}`)
        return []
      }
    },
  }
}

/**
 * Map one absolute file path to the scope id of the package containing it.
 * @param path - absolute file path.
 * @param layout - the workspace's packages.
 * @returns the deepest containing package's scope id — nested members resolve
 *   to the nearest one — or `undefined` when no package contains the path.
 */
export function scopeOf(path: string, layout: readonly WorkspacePackage[]): string | undefined {
  let best: WorkspacePackage | undefined
  for (const pkg of layout) {
    if (path !== pkg.dir && !path.startsWith(pkg.dir + sep)) continue
    if (best === undefined || pkg.dir.length > best.dir.length) best = pkg
  }
  return best?.scopeId
}
