/**
 * POSIX shell quoting and remote path joining, shared by every driver that
 * reaches a server over `ssh`.
 *
 * One implementation on purpose: quoting is the boundary that keeps a target
 * name or a configured path from becoming a command, and two copies of it are
 * two chances to get it wrong. A driver builds argv from these; nothing here
 * executes anything.
 */

/**
 * Wrap one value for POSIX `sh`. Single quotes suspend every expansion, and an
 * embedded quote is closed, escaped, and reopened.
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

/** Run one command on the remote host. `BatchMode` keeps a missing key a failure, not a prompt. */
export function remoteArgv(host: string, command: string): readonly string[] {
  return ['ssh', '-o', 'BatchMode=yes', host, command]
}

/** Prove the host answers before anything else touches it. */
export function sshPreflightArgv(host: string): readonly string[] {
  return remoteArgv(host, 'true')
}
