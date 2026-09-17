/** Locates the per-workspace private runtime root, shared by runtime resolution and settings mutation. */
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { sha256, within } from './identity.ts'

/** Runtime artifacts never enter the repository's source fingerprint. */
export async function projectOutput(workspace: string): Promise<string> {
  const canonical = await realpath(workspace)
  const output = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'midscene', 'projects', sha256(canonical))
  if (within(canonical, output)) throw new Error('MIDSCENE_PRIVATE_STORAGE_REQUIRED: DSH_HOME must be outside the project')
  await mkdir(output, { recursive: true, mode: 0o700 })
  if (await realpath(output) !== output) throw new Error('MIDSCENE_PRIVATE_STORAGE_ALIASED')
  return output
}
