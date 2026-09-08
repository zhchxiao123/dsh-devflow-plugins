/**
 * Every remote command the static driver runs, built as argv and executed
 * nowhere. Keeping construction pure is what makes the security boundary
 * testable: a spec asserts the exact argv, including quoting, without a server.
 *
 * Two remote trees carry one target:
 *
 * ```
 * <releasesRoot>/<target>/<releaseId>/   the payload rsync lands in, never served
 * <webRoot>/<target>                     the symlink the web server serves
 * ```
 *
 * Keeping payloads outside the served tree is deliberate. The alternative —
 * a dot-prefixed directory inside it, relying on the web server's own
 * dotfile-deny rule — makes the isolation depend on the operator's nginx
 * configuration rather than on the layout.
 */

import { quote, remoteArgv, remoteJoin } from '../../shell.ts'

export { quote, remoteArgv, remoteJoin, sshPreflightArgv } from '../../shell.ts'

/** Where one release's payload lives. */
export function releaseDir(releasesRoot: string, target: string, releaseId: string): string {
  return remoteJoin(releasesRoot, target, releaseId)
}

/** Where all of one target's releases live. */
export function releasesDir(releasesRoot: string, target: string): string {
  return remoteJoin(releasesRoot, target)
}

/** The served symlink for one target. */
export function servedLink(webRoot: string, target: string): string {
  return remoteJoin(webRoot, target)
}

/** Create the directory one release's payload will land in. */
export function makeReleaseDirArgv(
  host: string,
  releasesRoot: string,
  target: string,
  releaseId: string,
): readonly string[] {
  return remoteArgv(host, `mkdir -p ${quote(releaseDir(releasesRoot, target, releaseId))}`)
}

/**
 * Copy the built artifact into its own fresh release directory.
 *
 * There is no `--delete`: the destination is new every time, so the flag would
 * buy nothing and would turn a mistake in the destination path into data loss.
 * The previous release stays byte-for-byte intact throughout the transfer.
 */
export function rsyncArgv(
  localDir: string,
  host: string,
  releasesRoot: string,
  target: string,
  releaseId: string,
): readonly string[] {
  return [
    'rsync',
    '-az',
    `${localDir.replace(/\/+$/, '')}/`,
    `${host}:${releaseDir(releasesRoot, target, releaseId)}/`,
  ]
}

/**
 * Point the served symlink at one release.
 *
 * `ln -sfn` writes a temporary name, then one rename replaces the live link.
 * GNU `mv` needs `-T` to refuse treating that link as a directory; BSD `mv`
 * uses `-h` for the same no-dereference behavior. The first branch succeeds on
 * GNU systems, while the fallback handles BSD/macOS without weakening the
 * atomic switch. Replacing the symlink in place would unlink before
 * symlinking, and every request arriving in that window would 404 — which is
 * why this is a protocol constant rather than anything configurable.
 */
export function flipArgv(
  host: string,
  webRoot: string,
  releasesRoot: string,
  target: string,
  releaseId: string,
): readonly string[] {
  const link = servedLink(webRoot, target)
  const staging = `${link}.tmp.${releaseId}`
  return remoteArgv(
    host,
    `ln -sfn ${quote(releaseDir(releasesRoot, target, releaseId))} ${quote(staging)} `
    + `&& (mv -fT ${quote(staging)} ${quote(link)} 2>/dev/null `
    + `|| mv -fh ${quote(staging)} ${quote(link)})`,
  )
}

/** List one target's releases, newest name last; the driver owns the ordering it reports. */
export function listReleasesArgv(
  host: string,
  releasesRoot: string,
  target: string,
): readonly string[] {
  const dir = releasesDir(releasesRoot, target)
  return remoteArgv(host, `ls -1 ${quote(dir)} 2>/dev/null || true`)
}

/** Read which release the served symlink points at; empty output means nothing is deployed. */
export function readCurrentArgv(host: string, webRoot: string, target: string): readonly string[] {
  return remoteArgv(host, `readlink ${quote(servedLink(webRoot, target))} 2>/dev/null || true`)
}

/** Remove superseded release payloads. */
export function pruneArgv(
  host: string,
  releasesRoot: string,
  target: string,
  releaseIds: readonly string[],
): readonly string[] {
  const paths = releaseIds.map(id => quote(releaseDir(releasesRoot, target, id))).join(' ')
  return remoteArgv(host, `rm -rf ${paths}`)
}

/** The public address of a deployed target. */
export function targetUrl(baseUrl: string, target: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${target}/`
}
