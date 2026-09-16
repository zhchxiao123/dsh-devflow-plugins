/** Hashes source content, excluding only root Devflow runtime state; generated outputs stay external. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
/** Capture committed identity plus current tracked, deleted, executable, symlink, and untracked content. */
export async function workspaceIdentity(workspace: string): Promise<{ commit: string; workspaceSha256: string }> {
  const { stdout: root } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: workspace })
  if ((await realpath(root.trim())) !== (await realpath(workspace))) throw new Error('Workspace must be a Git root')
  const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })
  const { stdout: list } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: workspace,
    maxBuffer: 32 * 1024 * 1024,
  })
  const hash = createHash('sha256')
  for (const path of [...new Set(list.split('\0').filter(Boolean))].sort()) {
    if (path === '.devflow' || path.startsWith('.devflow/')) continue
    const full = join(workspace, path)
    const info = await lstat(full).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    let contentHash = 'deleted'
    if (info?.isSymbolicLink()) contentHash = sha256(await readlink(full))
    else if (info?.isFile()) contentHash = sha256(await readFile(full))
    else if (info) throw new Error('Unsupported workspace entry')
    hash.update(JSON.stringify([path, info?.mode ?? 'deleted', contentHash]))
  }
  return { commit: commit.trim(), workspaceSha256: hash.digest('hex') }
}
/** Compare canonical roots using platform path separators. */
export function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}
