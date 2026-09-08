/**
 * A stand-in for the far side of the SSH connection. `ssh` and `rsync` are
 * replaced with scripts on `PATH` that act on a local directory, so the driver
 * under test builds its real argv, and real `ln -sfn`, the host's supported
 * no-dereference `mv` form, `ls`, and `rm -rf` decide what happens. Only the
 * hop between machines is simulated — the flip whose atomicity the design
 * rests on is genuinely performed.
 */

import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Module-local declaration of the `process` members this file touches: the
// type-aware linter resolves the @types/node `process` global
// nondeterministically in this workspace, and a local declaration keeps its
// verdict stable. Runtime still binds the real global.
declare const process: { env: Record<string, string | undefined> }

/** Names of the executables the double replaces, in call order per invocation. */
const CALL_LOG = 'calls.log'

const SSH = `#!/bin/sh
printf 'ssh %s\\n' "$4" >> "$DEPLOY_FAKE_LOG"
if [ "$DEPLOY_FAKE_FAIL" = "ssh" ]; then echo "ssh refused" >&2; exit 255; fi
if [ "$DEPLOY_FAKE_FAIL" = "flip" ] && [ "\${4#ln -sfn}" != "$4" ]; then echo "flip refused" >&2; exit 1; fi
if [ "$DEPLOY_FAKE_FAIL" = "prune" ] && [ "\${4#rm -rf}" != "$4" ]; then echo "prune refused" >&2; exit 1; fi
shift 3
exec sh -c "$1"
`

const RSYNC = `#!/bin/sh
printf 'rsync %s %s\\n' "$2" "$3" >> "$DEPLOY_FAKE_LOG"
if [ "$DEPLOY_FAKE_FAIL" = "rsync" ]; then echo "rsync refused" >&2; exit 23; fi
src=$2
dest=$3
dest=\${dest#*:}
mkdir -p "$dest"
cp -a "$src." "$dest"
`

/** One prepared double: the fake binaries, the "remote" roots, and the call log. */
export interface RemoteDouble {
  readonly binDir: string
  readonly remoteWebRoot: string
  readonly remoteReleasesRoot: string
  readonly logPath: string
  /** Every ssh/rsync invocation, in order. */
  calls(): Promise<readonly string[]>
}

/** Install the double into a fresh temp directory. */
export async function createRemoteDouble(): Promise<RemoteDouble> {
  const base = await mkdtemp(join(tmpdir(), 'deploy-remote-'))
  const binDir = join(base, 'bin')
  const remoteWebRoot = join(base, 'srv', 'www')
  const remoteReleasesRoot = join(base, 'srv', 'releases')
  const logPath = join(base, CALL_LOG)
  await mkdir(binDir, { recursive: true })
  await mkdir(remoteWebRoot, { recursive: true })
  await mkdir(remoteReleasesRoot, { recursive: true })
  await writeFile(logPath, '')
  for (const [name, body] of [['ssh', SSH], ['rsync', RSYNC]] as const) {
    const path = join(binDir, name)
    await writeFile(path, body)
    await chmod(path, 0o755)
  }
  return {
    binDir,
    remoteWebRoot,
    remoteReleasesRoot,
    logPath,
    async calls() {
      const text = await readFile(logPath, 'utf8')
      return text.split('\n').filter(line => line !== '')
    },
  }
}

/**
 * Put the double's binaries in front of the real `ssh` and `rsync` for the
 * duration of one test, and point them at its call log.
 * @param double - the prepared double.
 * @returns a restore function for `afterEach`.
 */
export function usePath(double: RemoteDouble): () => void {
  const previous: string | undefined = process.env['PATH']
  process.env['PATH'] = `${double.binDir}:${previous ?? ''}`
  process.env['DEPLOY_FAKE_LOG'] = double.logPath
  return () => {
    if (previous === undefined) delete process.env['PATH']
    else process.env['PATH'] = previous
    delete process.env['DEPLOY_FAKE_LOG']
    delete process.env['DEPLOY_FAKE_FAIL']
  }
}
