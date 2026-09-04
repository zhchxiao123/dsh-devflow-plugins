/**
 * The container-service driver: a release is an image tag, and the pointer to
 * it is one line of the compose project's `.env`.
 *
 * The rollback class is `disruptive` because there is no atomic swap. Once
 * `docker compose up -d` runs, the previous container is gone, so a failure
 * after that point leaves the service down until something puts it back. That
 * is why a failed activation or verification retreats to the previous tag on
 * its own, and why the outcome of that retreat is reported rather than folded
 * into a generic failure: "deployed nothing, still healthy" and "deployed
 * nothing, currently down" call for very different next steps.
 */

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeployFailure } from '../../run.ts'
import { quote, remoteArgv, sshPreflightArgv } from '../../shell.ts'
import type {
  DeployOutcome,
  DeployRun,
  ReleaseInfo,
  ResolvedTarget,
  RollbackClass,
  TargetDriver,
  TargetStatus,
} from '../../types.ts'
import { readVar, setVar } from './env.ts'
import {
  composeUpArgv,
  containerIdArgv,
  dockerBuildArgv,
  dockerLoadArgv,
  dockerSaveArgv,
  dockerVersionArgv,
  healthArgv,
  imageInspectArgv,
  imageRemoveArgv,
  imageTagsArgv,
  readComposeArgv,
  readEnvArgv,
  remoteTarPath,
  removeRemoteFileArgv,
  sendArchiveArgv,
  writeEnvArgv,
} from './remote.ts'
import { validateServiceSpec } from './spec.ts'
import type { ReadySpec, ServiceSpec } from './spec.ts'

/** Deployment-varying settings this driver reads; the plugin validates them. */
export interface ServiceDriverConfig {
  readonly host: string
  /** Compose project directory on the host; its `.env` is the pointer this driver owns. */
  readonly composeDir: string
  /** Environment variable the compose file interpolates as the image tag. */
  readonly tagVarName: string
  /** Where the transferred image archive lands before it is loaded. */
  readonly remoteTmpDir: string
  /** Release images kept per target; the current one and its predecessor are never pruned. */
  readonly keepImages: number
  /** How long to wait for the new container to report ready. */
  readonly verifyTimeoutMs: number
  /** Delay between readiness attempts. */
  readonly readyPollIntervalMs: number
}

const KIND = 'service'

const ROLLBACK_CLASS: RollbackClass = {
  kind: 'disruptive',
  note: 'switching and rolling back both restart the container, so the service is briefly unavailable',
}

function message(error: unknown): string {
  /* v8 ignore next -- every throw reaching here is an Error; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}

/** Release tags as the host reported them, oldest first. */
function parseTags(output: string): readonly string[] {
  return output.split('\n').map(line => line.trim()).filter(line => line !== '' && line !== '<none>').sort()
}

function previousOf(releases: readonly string[], current: string | undefined): string | undefined {
  if (current === undefined) return releases[releases.length - 1]
  const index = releases.indexOf(current)
  return index <= 0 ? undefined : releases[index - 1]
}

/** Releases safe to delete: everything past the retention window, minus the two a rollback needs. */
export function prunableImages(
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

/** How a failed deploy left the service; the caller's next step depends on which. */
export type RetreatOutcome
  = /** The previous release is serving again and answered its readiness check. */
    | { readonly kind: 'recovered'; readonly releaseId: string }
    /** The previous release was restored but is not answering. Needs a human. */
    | { readonly kind: 'unhealthy'; readonly releaseId: string; readonly detail: string }
    /** Nothing was deployed before this attempt, so there was nothing to return to. */
    | { readonly kind: 'none' }

function retreatSummary(retreat: RetreatOutcome): string {
  if (retreat.kind === 'recovered') {
    return `the previous release ${retreat.releaseId} was restored and is healthy`
  }
  if (retreat.kind === 'unhealthy') {
    return `the previous release ${retreat.releaseId} was restored but IS NOT HEALTHY (${retreat.detail}); `
      + 'the service is down and needs attention'
  }
  return 'there was no previous release to return to; this target has never been deployed'
}

/** Build the service driver bound to one compose project. */
export function createServiceDriver(config: ServiceDriverConfig): TargetDriver<ServiceSpec> {
  const { host, composeDir, tagVarName, remoteTmpDir, keepImages, verifyTimeoutMs, readyPollIntervalMs } = config

  async function readPointer(run: DeployRun): Promise<{ contents: string; current: string | undefined }> {
    const read = await run.mustExec(readEnvArgv(host, composeDir))
    return { contents: read.output, current: readVar(read.output, tagVarName) }
  }

  async function releasesOn(run: DeployRun, image: string): Promise<readonly string[]> {
    const listed = await run.mustExec(imageTagsArgv(host, image))
    return parseTags(listed.output)
  }

  /** Point the pointer at one release and bring the service up on it. */
  async function activate(run: DeployRun, releaseId: string, spec: ServiceSpec): Promise<void> {
    const { contents } = await readPointer(run)
    await run.mustExec(writeEnvArgv(host, composeDir, setVar(contents, tagVarName, releaseId)))
    await run.mustExec(composeUpArgv(host, composeDir, spec.service))
  }

  /** Poll the declared readiness check until it passes or the deadline expires. */
  async function verify(run: DeployRun, spec: ServiceSpec): Promise<string | undefined> {
    const deadline = performance.now() + verifyTimeoutMs
    let detail = 'the readiness check never passed'
    for (;;) {
      const attempt = await probe(run, spec.ready, spec)
      if (attempt === undefined) return undefined
      detail = attempt
      if (performance.now() >= deadline) return `${detail} within ${verifyTimeoutMs}ms`
      await new Promise((resolve) => { setTimeout(resolve, readyPollIntervalMs) })
    }
  }

  /** One readiness attempt; `undefined` means ready, a string says what is wrong. */
  async function probe(run: DeployRun, ready: ReadySpec, spec: ServiceSpec): Promise<string | undefined> {
    if (ready.kind === 'docker') {
      const id = (await run.exec(containerIdArgv(host, composeDir, spec.service))).output.trim()
      if (id === '') return 'the compose service has no running container'
      const status = (await run.exec(healthArgv(host, id))).output.trim()
      if (status === 'healthy') return undefined
      if (status === 'none') {
        return 'the container declares no HEALTHCHECK, so `ready: { docker: health }` cannot answer; '
          + 'declare an http or tcp check instead, or add a HEALTHCHECK to the image'
      }
      return `the container reports health '${status}'`
    }
    const command = ready.kind === 'http'
      ? `curl -fsS -o /dev/null --max-time 5 ${quote(ready.url)}`
      : `exec 3<>/dev/tcp/127.0.0.1/${ready.port}`
    const result = await run.exec(remoteArgv(host, command))
    return result.ok
      ? undefined
      : ready.kind === 'http'
        ? `the endpoint ${ready.url} did not answer`
        : `nothing accepted a connection on port ${ready.port}`
  }

  async function retreat(run: DeployRun, spec: ServiceSpec, previous: string | undefined): Promise<RetreatOutcome> {
    if (previous === undefined) return { kind: 'none' }
    try {
      await activate(run, previous, spec)
    } catch (error) {
      return { kind: 'unhealthy', releaseId: previous, detail: message(error) }
    }
    const detail = await verify(run, spec)
    return detail === undefined
      ? { kind: 'recovered', releaseId: previous }
      : { kind: 'unhealthy', releaseId: previous, detail }
  }

  return {
    kind: KIND,
    rollbackClass: ROLLBACK_CLASS,
    validate: validateServiceSpec,

    async deploy(run, target) {
      const { spec } = target
      const releaseId = run.releaseId()

      run.phase('build')
      await run.mustExec(
        dockerBuildArgv(spec.image, releaseId, spec.context, spec.dockerfile),
        { timeoutMs: run.deadlines.buildMs },
      )

      run.phase('preflight')
      await run.mustExec(imageInspectArgv(spec.image, releaseId))
      await run.mustExec(sshPreflightArgv(host))
      await run.mustExec(dockerVersionArgv(host))
      const compose = await run.mustExec(readComposeArgv(host, composeDir))
      if (compose.output.trim() === '') {
        throw new DeployFailure('preflight', `no compose file was found in ${composeDir} on ${host}`)
      }
      if (!compose.output.includes(tagVarName)) {
        throw new DeployFailure(
          'preflight',
          `the compose file in ${composeDir} never references \${${tagVarName}}, so deploying would not change `
          + 'which image runs; point the service\'s `image:` at that variable',
        )
      }
      // Read before anything is stopped: this is the release a failed
      // activation retreats to, and reading it afterwards would be too late.
      const before = await readPointer(run)
      const previous = before.current

      run.phase('transfer')
      const localTar = join(tmpdir(), `${spec.image.replaceAll('/', '_')}-${releaseId}.tar`)
      const remoteTar = remoteTarPath(remoteTmpDir, spec.image, releaseId)
      try {
        await run.mustExec(dockerSaveArgv(spec.image, releaseId, localTar))
        await run.mustExec(sendArchiveArgv(localTar, host, remoteTar))
        await run.mustExec(dockerLoadArgv(host, remoteTar))
      } finally {
        await rm(localTar, { force: true }).catch(() => {
          run.warn(`the local image archive ${localTar} could not be removed`)
        })
        const removal = await run.exec(removeRemoteFileArgv(host, remoteTar))
        if (!removal.ok) run.warn(`the transferred archive ${remoteTar} could not be removed from ${host}`)
      }

      run.phase('activate')
      const failure = await attemptSwitch(run, releaseId, spec, previous)
      if (failure !== undefined) throw failure

      run.phase('prune')
      const releases = [...new Set([...await releasesOn(run, spec.image), releaseId])].sort()
      const doomed = prunableImages(releases, releaseId, keepImages)
      if (doomed.length > 0) {
        const removal = await run.exec(imageRemoveArgv(host, spec.image, doomed))
        if (!removal.ok) {
          run.warn(`the deploy succeeded but ${doomed.length} superseded image(s) could not be removed`)
        }
      }
      return { releaseId }
    },

    async status(run, target) {
      const { name, spec } = target
      const { current } = await readPointer(run)
      const releases = await releasesOn(run, spec.image)
      return {
        name,
        kind: KIND,
        rollbackClass: ROLLBACK_CLASS,
        releases: releases.map((id): ReleaseInfo => ({ id, current: id === current })).reverse(),
        ...current === undefined ? {} : { currentRelease: current },
      } satisfies TargetStatus
    },

    async rollback(run: DeployRun, target: ResolvedTarget<ServiceSpec>, to?: string) {
      const { name, spec } = target
      run.phase('preflight')
      await run.mustExec(sshPreflightArgv(host))
      const { current } = await readPointer(run)
      const releases = await releasesOn(run, spec.image)
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
          `target '${name}' has no release '${wanted}' on ${host}; available releases: ${[...releases].reverse().join(', ')}`,
        )
      }
      run.phase('activate')
      await activate(run, wanted, spec)
      run.phase('verify')
      const detail = await verify(run, spec)
      if (detail !== undefined) {
        // A failed rollback does not retreat again: the caller asked for this
        // release deliberately, and swapping back and forth would leave the
        // service flapping while hiding which version is actually broken.
        throw new DeployFailure(
          'verify',
          `rolled back to ${wanted}, but ${detail}; the service is down and no further switch was attempted`,
        )
      }
      return { releaseId: wanted } satisfies DeployOutcome
    },
  }

  /** Switch to a release, retreating on failure; returns the failure to raise, or `undefined`. */
  async function attemptSwitch(
    run: DeployRun,
    releaseId: string,
    spec: ServiceSpec,
    previous: string | undefined,
  ): Promise<DeployFailure | undefined> {
    let cause: string
    try {
      await activate(run, releaseId, spec)
      run.phase('verify')
      const detail = await verify(run, spec)
      if (detail === undefined) return undefined
      cause = detail
    } catch (error) {
      cause = message(error)
    }
    const outcome = await retreat(run, spec, previous)
    return new DeployFailure(
      outcome.kind === 'unhealthy' ? 'verify' : 'activate',
      `release ${releaseId} did not come up (${cause}); ${retreatSummary(outcome)}`,
    )
  }
}
