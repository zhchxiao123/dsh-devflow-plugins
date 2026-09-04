/**
 * Every command the service driver runs, built as argv and executed nowhere.
 *
 * The version of a service is an image tag, and the pointer to it is one line
 * of the compose project's `.env`:
 *
 * ```
 * <image>:<releaseId>            the version, in the remote image store
 * <composeDir>/.env              the pointer, read by `docker compose up -d`
 * ```
 *
 * That mirrors the static kind's release directory and served symlink, and it
 * is why nothing here writes `docker-compose.yml`: the compose file is the
 * operator's, and the plugin owns only the variable it points at.
 */

import { quote, remoteArgv, remoteJoin } from '../../shell.ts'

/** The image reference one release publishes. */
export function imageRef(image: string, releaseId: string): string {
  return `${image}:${releaseId}`
}

/** Where the transferred image archive lands before it is loaded. */
export function remoteTarPath(remoteTmpDir: string, image: string, releaseId: string): string {
  return remoteJoin(remoteTmpDir, `${image.replaceAll('/', '_')}-${releaseId}.tar`)
}

/** The compose project's environment file — the pointer this plugin owns. */
export function envPath(composeDir: string): string {
  return remoteJoin(composeDir, '.env')
}

/** Build the release's image locally. */
export function dockerBuildArgv(
  image: string,
  releaseId: string,
  context: string,
  dockerfile: string | undefined,
): readonly string[] {
  return [
    'docker', 'build',
    '-t', imageRef(image, releaseId),
    ...dockerfile === undefined ? [] : ['-f', dockerfile],
    context,
  ]
}

/** Prove the built image exists before anything is transferred. */
export function imageInspectArgv(image: string, releaseId: string): readonly string[] {
  return ['docker', 'image', 'inspect', imageRef(image, releaseId)]
}

/**
 * Write the release's image to a local archive.
 *
 * `save` and `load` stay separate commands rather than one pipe: commands run
 * through `sh -c`, `pipefail` is not POSIX, and a pipe would report only the
 * last command's exit status — turning a failed `save` into an ambiguous
 * downstream error instead of a failure attributed to its own step.
 */
export function dockerSaveArgv(image: string, releaseId: string, outFile: string): readonly string[] {
  return ['docker', 'save', imageRef(image, releaseId), '-o', outFile]
}

/** Send the archive to the host. `-z` matters: an image archive compresses well. */
export function sendArchiveArgv(localTar: string, host: string, remotePath: string): readonly string[] {
  return ['rsync', '-z', localTar, `${host}:${remotePath}`]
}

/** Load the transferred archive into the host's image store. */
export function dockerLoadArgv(host: string, remotePath: string): readonly string[] {
  return remoteArgv(host, `docker load -i ${quote(remotePath)}`)
}

/** Prove the host can run docker before the running container is touched. */
export function dockerVersionArgv(host: string): readonly string[] {
  return remoteArgv(host, 'docker version --format {{.Server.Version}}')
}

/** Read the compose file, so preflight can prove it references the tag variable. */
export function readComposeArgv(host: string, composeDir: string): readonly string[] {
  const dir = quote(composeDir)
  return remoteArgv(host, `cat ${dir}/docker-compose.yml 2>/dev/null || cat ${dir}/compose.yml 2>/dev/null || true`)
}

/** Read the pointer file; empty output means nothing is deployed yet. */
export function readEnvArgv(host: string, composeDir: string): readonly string[] {
  return remoteArgv(host, `cat ${quote(envPath(composeDir))} 2>/dev/null || true`)
}

/**
 * Replace the pointer file with new contents.
 *
 * The whole file is written because the driver read it first and changed one
 * line; `printf %s` avoids the escape interpretation `echo` applies to
 * backslashes in some shells.
 */
export function writeEnvArgv(host: string, composeDir: string, contents: string): readonly string[] {
  return remoteArgv(host, `printf %s ${quote(contents)} > ${quote(envPath(composeDir))}`)
}

/** Bring the compose service up on whatever tag the pointer now names. */
export function composeUpArgv(host: string, composeDir: string, service: string): readonly string[] {
  return remoteArgv(host, `cd ${quote(composeDir)} && docker compose up -d ${quote(service)}`)
}

/** The container id backing one compose service, or empty output when it is down. */
export function containerIdArgv(host: string, composeDir: string, service: string): readonly string[] {
  return remoteArgv(host, `cd ${quote(composeDir)} && docker compose ps -q ${quote(service)} 2>/dev/null || true`)
}

/** The container's own health verdict; `none` when the image declares no HEALTHCHECK. */
export function healthArgv(host: string, containerId: string): readonly string[] {
  return remoteArgv(
    host,
    `docker inspect --format {{.State.Health.Status}} ${quote(containerId)} 2>/dev/null || echo none`,
  )
}

/** List the release tags present on the host, newest name last. */
export function imageTagsArgv(host: string, image: string): readonly string[] {
  return remoteArgv(
    host,
    `docker image ls ${quote(image)} --format {{.Tag}} 2>/dev/null | sort || true`,
  )
}

/** Remove superseded images. */
export function imageRemoveArgv(host: string, image: string, releaseIds: readonly string[]): readonly string[] {
  const refs = releaseIds.map(id => quote(imageRef(image, id))).join(' ')
  return remoteArgv(host, `docker image rm ${refs}`)
}

/** Delete the transferred archive once it has been loaded. */
export function removeRemoteFileArgv(host: string, path: string): readonly string[] {
  return remoteArgv(host, `rm -f ${quote(path)}`)
}
