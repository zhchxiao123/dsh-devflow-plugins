/**
 * A stand-in for `docker` on both sides of the SSH hop, plus the `ssh` and
 * `rsync` that carry an image between them.
 *
 * The fake docker keeps its state on disk — an image store, one `.env` per
 * compose project, and a "container" record — so the driver's real argv, real
 * `.env` rewriting, real tag arithmetic, and real retreat sequence all run.
 * Only docker itself and the hop between machines are simulated.
 *
 * `DOCKER_FAKE_*` variables steer failures. They are read by the scripts, not
 * by the driver, so a test arranges a failure the same way the world would:
 * by making a command fail.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activateCommandDoubles, prepareCommandDoubles } from './command-doubles.ts'
import type { CommandDoubles } from './command-doubles.ts'

// Module-local declaration of the `process` members this file touches: the
// type-aware linter resolves the @types/node `process` global
// nondeterministically in this workspace, and a local declaration keeps its
// verdict stable. Runtime still binds the real global.
declare const process: { env: Record<string, string | undefined> }

const SSH = `#!/bin/sh
printf 'ssh %s\\n' "$4" >> "$DOCKER_FAKE_LOG"
if [ "$DOCKER_FAKE_FAIL" = "ssh" ]; then echo "ssh refused" >&2; exit 255; fi
case "$4" in
  curl*) [ -n "$DOCKER_FAKE_CURL_FAIL" ] && { echo "curl failed" >&2; exit 22; }; exit 0 ;;
  exec*dev/tcp*) [ -n "$DOCKER_FAKE_TCP_FAIL" ] && { echo "refused" >&2; exit 1; }; exit 0 ;;
  "rm -f"*) [ -n "$DOCKER_FAKE_RMFILE_FAIL" ] && { echo "cannot remove" >&2; exit 1; } ;;
esac
shift 3
exec sh -c "$1"
`

const RSYNC = `#!/bin/sh
printf 'rsync %s %s\\n' "$2" "$3" >> "$DOCKER_FAKE_LOG"
if [ "$DOCKER_FAKE_FAIL" = "rsync" ]; then echo "rsync refused" >&2; exit 23; fi
dest=$3
dest=\${dest#*:}
cp "$2" "$dest"
`

// One script serves as docker on both sides: the "remote" store is a directory
// the fake ssh reaches by simply running locally.
const DOCKER = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$DOCKER_FAKE_LOG"
store=$DOCKER_FAKE_STORE
mkdir -p "$store/images"
ref_file() { printf '%s/images/%s' "$store" "$(printf %s "$1" | tr '/:' '__')"; }
sub=$1
shift
case "$sub" in
  build)
    [ "$DOCKER_FAKE_FAIL" = "build" ] && { echo "build failed" >&2; exit 1; }
    ref=""
    while [ $# -gt 0 ]; do
      case $1 in
        -t) ref=$2; shift 2 ;;
        -f) shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'built\\n' > "$(ref_file "$ref")"
    ;;
  image)
    action=$1
    shift
    case "$action" in
      inspect)
        [ -f "$(ref_file "$1")" ] || { echo "no such image: $1" >&2; exit 1; }
        ;;
      ls)
        prefix=$(printf %s "$1" | tr '/' '_')
        ls -1 "$store/images" 2>/dev/null | sed -n "s/^\${prefix}_//p"
        ;;
      rm)
        [ "$DOCKER_FAKE_FAIL" = "rm" ] && { echo "rm refused" >&2; exit 1; }
        for ref in "$@"; do rm -f "$(ref_file "$ref")"; done
        ;;
    esac
    ;;
  save) printf 'image %s\\n' "$1" > "$3" ;;
  load)
    ref=$(sed -n 's/^image //p' "$2")
    printf 'built\\n' > "$(ref_file "$ref")"
    ;;
  version)
    [ "$DOCKER_FAKE_FAIL" = "version" ] && { echo "cannot connect" >&2; exit 1; }
    echo 27.0.0
    ;;
  compose)
    action=$1
    tag=$(sed -n 's/^APP_IMAGE_TAG=//p' .env 2>/dev/null | tail -1)
    case "$action" in
      up)
        if [ "$DOCKER_FAKE_FAIL_TAG" = "$tag" ] || [ "$DOCKER_FAKE_FAIL" = "up" ]; then
          echo "container for $tag refused to start" >&2; exit 1
        fi
        printf '%s\\n' "$tag" > "$store/running"
        ;;
      ps)
        [ -n "$DOCKER_FAKE_NO_CONTAINER" ] && exit 0
        [ -f "$store/running" ] && echo container-1
        ;;
    esac
    ;;
  inspect)
    [ -n "$DOCKER_FAKE_NO_HEALTHCHECK" ] && { echo none; exit 0; }
    running=$(cat "$store/running" 2>/dev/null)
    if [ "$DOCKER_FAKE_UNHEALTHY_TAG" = "$running" ]; then echo unhealthy; else echo healthy; fi
    ;;
esac
exit 0
`

/** One prepared double: the fake binaries, the image store, and the call log. */
export interface DockerDouble {
  readonly binDir: string
  readonly commandDoubles: CommandDoubles
  /** Compose project directory; its `.env` is what the driver rewrites. */
  readonly composeDir: string
  /** Where the fake docker keeps images and the running tag. */
  readonly storeDir: string
  readonly logPath: string
  /** Every ssh/rsync/docker invocation, in order. */
  calls(): Promise<readonly string[]>
  /** The tag the "container" is running, or `undefined` when nothing is up. */
  running(): Promise<string | undefined>
  /** The compose project's `.env` as it stands. */
  env(): Promise<string>
}

/** Install the double into a fresh temp directory. */
export async function createDockerDouble(compose = 'image: myapp:${APP_IMAGE_TAG}\n'): Promise<DockerDouble> {
  const base = await mkdtemp(join(tmpdir(), 'deploy-docker-'))
  const binDir = join(base, 'bin')
  const composeDir = join(base, 'opt', 'app')
  const storeDir = join(base, 'store')
  const logPath = join(base, 'calls.log')
  await mkdir(binDir, { recursive: true })
  await mkdir(composeDir, { recursive: true })
  await mkdir(join(storeDir, 'images'), { recursive: true })
  await mkdir(join(storeDir, 'tmp'), { recursive: true })
  await writeFile(logPath, '')
  await writeFile(join(composeDir, 'docker-compose.yml'), compose)
  const commandDoubles = await prepareCommandDoubles(binDir, { ssh: SSH, rsync: RSYNC, docker: DOCKER })
  return {
    binDir,
    commandDoubles,
    composeDir,
    storeDir,
    logPath,
    async calls() {
      return (await readFile(logPath, 'utf8')).split('\n').filter(line => line !== '')
    },
    async running() {
      const value = await readFile(join(storeDir, 'running'), 'utf8').catch(() => '')
      return value.trim() === '' ? undefined : value.trim()
    },
    env() {
      return readFile(join(composeDir, '.env'), 'utf8').catch(() => '')
    },
  }
}

/**
 * Put the double's binaries in front of the real ones for the duration of one
 * test, and point them at its store and call log.
 * @param double - the prepared double.
 * @returns a restore function for `afterEach`.
 */
export function useDockerPath(double: DockerDouble): () => void {
  const restoreCommands = activateCommandDoubles(double.commandDoubles)
  process.env['DOCKER_FAKE_LOG'] = double.logPath
  process.env['DOCKER_FAKE_STORE'] = double.storeDir
  return () => {
    restoreCommands()
    delete process.env['DOCKER_FAKE_LOG']
    delete process.env['DOCKER_FAKE_STORE']
    delete process.env['DOCKER_FAKE_FAIL']
    delete process.env['DOCKER_FAKE_FAIL_TAG']
    delete process.env['DOCKER_FAKE_UNHEALTHY_TAG']
    delete process.env['DOCKER_FAKE_NO_HEALTHCHECK']
    delete process.env['DOCKER_FAKE_CURL_FAIL']
    delete process.env['DOCKER_FAKE_TCP_FAIL']
    delete process.env['DOCKER_FAKE_RMFILE_FAIL']
    delete process.env['DOCKER_FAKE_NO_CONTAINER']
  }
}
