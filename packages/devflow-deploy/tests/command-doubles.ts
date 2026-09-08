/**
 * Install shell-backed command doubles on PATH on POSIX and Windows.
 *
 * The Harness Windows subprocess runner intentionally resolves only native
 * applications. A bare executable shell script therefore cannot shadow
 * `docker`, `ssh`, or `rsync` there. The test runtime below translates only
 * those prepared argv heads to Git's shell while leaving every other command
 * on the real subprocess path. Keeping the shell in place matters: its runtime
 * lookup is relative to that location.
 */

import { access, chmod, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
}

/** The prepared directory and Windows-only shell routes. */
export interface CommandDoubles {
  readonly binDir: string
  readonly windows?: {
    readonly shell: string
    readonly scripts: Readonly<Record<string, string>>
  }
}

let activeWindowsDoubles: CommandDoubles['windows']

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

/** Translate a native Windows path into the path Git's shell sees. */
export function commandDoubleShellPath(path: string): string {
  if (process.platform !== 'win32') return path
  const normalized = path.replaceAll('\\', '/')
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized)
  return drive?.[1] === undefined || drive[2] === undefined
    ? normalized
    : `/${drive[1].toLowerCase()}/${drive[2]}`
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
  if (process.platform !== 'win32') return { binDir }

  const shell = await windowsShell()
  const scripts = Object.fromEntries(
    Object.keys(commands).map(name => [name, commandDoubleShellPath(join(binDir, name))]),
  )
  return { binDir, windows: { shell, scripts } }
}

/** Real Harness runtime with the Windows-only executable-script test seam. */
export class CommandDoubleSubprocessRuntime extends LocalSubprocessRuntime {
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const command = spec.argv[0]?.toLowerCase()
    const script = command === undefined ? undefined : activeWindowsDoubles?.scripts[command]
    if (process.platform !== 'win32' || script === undefined || activeWindowsDoubles === undefined) {
      return super.spawn(spec)
    }
    return super.spawn({
      ...spec,
      argv: [activeWindowsDoubles.shell, script, ...spec.argv.slice(1)],
    })
  }
}

/** Activate prepared doubles and return an exact environment restore. */
export function activateCommandDoubles(doubles: CommandDoubles): () => void {
  const changed = new Map<string, string | undefined>()
  const previousWindowsDoubles = activeWindowsDoubles
  activeWindowsDoubles = doubles.windows
  const set = (name: string, value: string): void => {
    changed.set(name, process.env[name])
    process.env[name] = value
  }
  set('PATH', `${doubles.binDir}${delimiter}${process.env['PATH'] ?? ''}`)
  return () => {
    activeWindowsDoubles = previousWindowsDoubles
    for (const [name, value] of changed) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}
