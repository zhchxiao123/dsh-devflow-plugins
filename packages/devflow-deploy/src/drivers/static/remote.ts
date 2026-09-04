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

/**
 * Wrap one value for POSIX `sh`. Single quotes suspend every expansion, and
 * an embedded quote is closed, escaped, and reopened — the one construction
 * every interpolated path and identifier here goes through.
 */
export function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/** Join remote path segments; the remote side is POSIX, so the separator is fixed. */
export function remoteJoin(...segments: readonly string[]): string {
  return segments
    .map((segment, index) => (index === 0 ? segment.replace(/\/+$/, '') : segment.replace(/^\/+|\/+$/g, '')))
    .filter(segment => segment !== '')
    .join('/')
}

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

/** Run one command on the remote host. `BatchMode` keeps a missing key a failure, not a prompt. */
export function remoteArgv(host: string, command: string): readonly string[] {
  return ['ssh', '-o', 'BatchMode=yes', host, command]
}

/** Prove the host answers before anything else touches it. */
export function sshPreflightArgv(host: string): readonly string[] {
  return remoteArgv(host, 'true')
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
 * `ln -sfn` writes a temporary name and `mv -T` renames it over the live one.
 * The rename is atomic, so a visitor sees either the old release or the new
 * one. Replacing the symlink in place would unlink before symlinking, and
 * every request arriving in that window would 404 — which is why this is a
 * protocol constant rather than anything configurable.
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
    + `&& mv -T ${quote(staging)} ${quote(link)}`,
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
