/**
 * The static-site driver: a built artifact directory becomes its own remote
 * release, and one atomic symlink rename puts it in front of visitors.
 *
 * The rollback class is `atomic` because returning to a previous release is
 * the same rename in the other direction — no re-transfer, no interruption.
 * That promise is why every step before the flip must be able to fail without
 * touching what is live, which is what the `preflight` boundary enforces.
 */

import { readdir, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { DeployFailure } from '../../run.ts'
import type {
  DeployOutcome,
  DeployRun,
  ReleaseInfo,
  ResolvedTarget,
  RollbackClass,
  TargetDriver,
  TargetStatus,
} from '../../types.ts'
import {
  flipArgv,
  listReleasesArgv,
  makeReleaseDirArgv,
  pruneArgv,
  readCurrentArgv,
  rsyncArgv,
  sshPreflightArgv,
  targetUrl,
} from './remote.ts'
import { validateStaticSpec } from './spec.ts'
import type { StaticSpec } from './spec.ts'

/** Deployment-varying settings this driver reads; the plugin validates them. */
export interface StaticDriverConfig {
  readonly host: string
  readonly remoteWebRoot: string
  readonly remoteReleasesRoot: string
  readonly baseUrl: string
  readonly keepReleases: number
}

const KIND = 'static'

const ROLLBACK_CLASS: RollbackClass = { kind: 'atomic' }

/** Release identifiers as the remote reported them, oldest first. */
function parseReleases(output: string): readonly string[] {
  return output.split('\n').map(line => line.trim()).filter(line => line !== '').sort()
}

/** The release the served symlink points at; empty output means nothing is deployed. */
function parseCurrent(output: string): string | undefined {
  return output.trim().split('/').filter(segment => segment !== '').pop()
}

async function assertArtifact(run: DeployRun, spec: StaticSpec, path: string): Promise<void> {
  let entries: string[]
  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      throw new DeployFailure('preflight', `the artifact path '${spec.dir}' is not a directory`)
    }
    entries = await readdir(path)
  } catch (error) {
    if (error instanceof DeployFailure) throw error
    throw new DeployFailure('preflight', `the artifact directory '${spec.dir}' could not be read; run the target's build first`)
  }
  if (entries.length === 0) {
    throw new DeployFailure('preflight', `the artifact directory '${spec.dir}' is empty; run the target's build first`)
  }
  const entryPath = resolve(path, spec.entry)
  try {
    await stat(entryPath)
  } catch {
    throw new DeployFailure('preflight', `the artifact directory '${spec.dir}' has no '${spec.entry}'; the build did not produce a site`)
  }
  await assertNoEscapingLinks(run, spec, path)
}

/**
 * Refuse an artifact whose symlinks leave it. `rsync -a` copies links as
 * links, so an escaping one would either dangle on the server or publish
 * whatever it happens to resolve to there.
 */
async function assertNoEscapingLinks(_run: DeployRun, spec: StaticSpec, path: string): Promise<void> {
  const base = await realpath(path)
  const pending = [path]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const child = resolve(dir, item.name)
      if (item.isDirectory()) {
        pending.push(child)
        continue
      }
      if (!item.isSymbolicLink()) continue
      const resolved = await realpath(child).catch(() => '')
      if (resolved === '' || (resolved !== base && !resolved.startsWith(base + sep))) {
        throw new DeployFailure(
          'preflight',
          `the artifact directory '${spec.dir}' contains a symlink that leaves it: `
          + child.slice(path.length + 1),
        )
      }
    }
  }
}

/** Releases safe to delete: everything past the retention window, minus the two a rollback needs. */
export function prunable(
  releases: readonly string[],
  current: string | undefined,
  keep: number,
): readonly string[] {
  const retained = new Set(releases.slice(-keep))
  if (current !== undefined) {
    retained.add(current)
    const previous = releases[releases.indexOf(current) - 1]
    if (previous !== undefined) retained.add(previous)
  }
  return releases.filter(id => !retained.has(id))
}

/** Build the static driver bound to one server's layout. */
export function createStaticDriver(config: StaticDriverConfig): TargetDriver<StaticSpec> {
  const { host, remoteWebRoot, remoteReleasesRoot, baseUrl, keepReleases } = config

  async function readState(
    run: DeployRun,
    name: string,
  ): Promise<{ releases: readonly string[]; current: string | undefined }> {
    const listed = await run.mustExec(listReleasesArgv(host, remoteReleasesRoot, name))
    const link = await run.mustExec(readCurrentArgv(host, remoteWebRoot, name))
    return { releases: parseReleases(listed.output), current: parseCurrent(link.output) }
  }

  async function flipTo(run: DeployRun, name: string, releaseId: string): Promise<DeployOutcome> {
    run.phase('activate')
    await run.mustExec(flipArgv(host, remoteWebRoot, remoteReleasesRoot, name, releaseId))
    return { releaseId, url: targetUrl(baseUrl, name) }
  }

  return {
    kind: KIND,
    rollbackClass: ROLLBACK_CLASS,
    validate: validateStaticSpec,

    async deploy(run, target) {
      const { name, spec } = target
      run.phase('preflight')
      await assertArtifact(run, spec, resolve(run.root, spec.dir))
      await run.mustExec(sshPreflightArgv(host))
      const before = await readState(run, name)

      const releaseId = run.releaseId()
      run.phase('transfer')
      await run.mustExec(makeReleaseDirArgv(host, remoteReleasesRoot, name, releaseId))
      await run.mustExec(rsyncArgv(resolve(run.root, spec.dir), host, remoteReleasesRoot, name, releaseId))

      const outcome = await flipTo(run, name, releaseId)

      run.phase('prune')
      const releases = [...new Set([...before.releases, releaseId])].sort()
      const doomed = prunable(releases, releaseId, keepReleases)
      if (doomed.length > 0) {
        const removal = await run.exec(pruneArgv(host, remoteReleasesRoot, name, doomed))
        if (!removal.ok) {
          run.warn(`the deploy succeeded but ${doomed.length} superseded release(s) could not be removed`)
        }
      }
      return outcome
    },

    async status(run, target) {
      const { name } = target
      const { releases, current } = await readState(run, name)
      return {
        name,
        kind: KIND,
        rollbackClass: ROLLBACK_CLASS,
        releases: releases.map((id): ReleaseInfo => ({ id, current: id === current })).reverse(),
        ...current === undefined ? {} : { currentRelease: current, url: targetUrl(baseUrl, name) },
      } satisfies TargetStatus
    },

    async rollback(run: DeployRun, target: ResolvedTarget<StaticSpec>, to?: string) {
      const { name } = target
      run.phase('preflight')
      await run.mustExec(sshPreflightArgv(host))
      const { releases, current } = await readState(run, name)
      if (releases.length === 0) {
        throw new DeployFailure('preflight', `target '${name}' has no releases to roll back to`)
      }
      const wanted = to ?? previousOf(releases, current)
      if (wanted === undefined) {
        throw new DeployFailure(
          'preflight',
          `target '${name}' is already at its oldest release; there is nothing to roll back to`,
        )
      }
      if (!releases.includes(wanted)) {
        throw new DeployFailure(
          'preflight',
          `target '${name}' has no release '${wanted}'; available releases: ${[...releases].reverse().join(', ')}`,
        )
      }
      return flipTo(run, name, wanted)
    },
  }
}

function previousOf(releases: readonly string[], current: string | undefined): string | undefined {
  if (current === undefined) return releases[releases.length - 1]
  const index = releases.indexOf(current)
  return index <= 0 ? undefined : releases[index - 1]
}
