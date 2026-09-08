/**
 * Install shell-backed command doubles on PATH on POSIX and Windows.
 *
 * The Harness Windows subprocess runner intentionally resolves only native
 * `.com`/`.exe` applications. A bare executable shell script therefore cannot
 * shadow `docker`, `ssh`, or `rsync` there. On Windows we hard-link (or copy)
 * Git's `sh.exe` under each command name and use `BASH_ENV` to dispatch that
 * shell to the matching script before it treats argv[1] as a script file. The
 * production command path still crosses the real subprocess runtime.
 */

import { access, chmod, copyFile, link, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
}

const DOUBLE_DIR = 'DSH_COMMAND_DOUBLE_DIR'

/** The prepared directory and Windows-only shell bootstrap environment. */
export interface CommandDoubles {
  readonly binDir: string
  readonly environment: Readonly<Record<string, string>>
}

async function windowsShell(): Promise<string> {
  const path = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const executable of ['sh.exe', 'bash.exe']) {
      const candidate = join(directory.replace(/^"|"$/g, ''), executable)
      try {
        await access(candidate)
        return candidate
      } catch {
        // This PATH entry does not carry Git's shell; keep looking.
      }
    }
  }
  throw new Error('the Windows command doubles require sh.exe or bash.exe on PATH')
}

async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target)
  } catch {
    // A temp directory can live on another volume, where a hard link is
    // impossible. Copying preserves the same executable behavior.
    await copyFile(source, target)
  }
}

/** Write each fake command and make it discoverable by the Harness runtime. */
export async function prepareCommandDoubles(
  binDir: string,
  commands: Readonly<Record<string, string>>,
): Promise<CommandDoubles> {
  for (const [name, body] of Object.entries(commands)) {
    const path = join(binDir, name)
    await writeFile(path, body)
    await chmod(path, 0o755)
  }
  if (process.platform !== 'win32') return { binDir, environment: {} }

  const shell = await windowsShell()
  for (const name of Object.keys(commands)) await linkOrCopy(shell, join(binDir, `${name}.exe`))
  const dispatcher = join(binDir, 'dispatch.sh')
  await writeFile(dispatcher, [
    'name=$(basename "$0" .exe)',
    `case "$name" in ${Object.keys(commands).join('|')}) . "$${DOUBLE_DIR}/$name" ;; esac`,
    '',
  ].join('\n'))
  return {
    binDir,
    environment: {
      [DOUBLE_DIR]: binDir,
      BASH_ENV: dispatcher,
      ENV: dispatcher,
    },
  }
}

/** Activate prepared doubles and return an exact environment restore. */
export function activateCommandDoubles(doubles: CommandDoubles): () => void {
  const changed = new Map<string, string | undefined>()
  const set = (name: string, value: string): void => {
    changed.set(name, process.env[name])
    process.env[name] = value
  }
  set('PATH', `${doubles.binDir}${delimiter}${process.env['PATH'] ?? ''}`)
  for (const [name, value] of Object.entries(doubles.environment)) set(name, value)
  return () => {
    for (const [name, value] of changed) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}
