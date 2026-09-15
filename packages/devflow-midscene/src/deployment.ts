/** The deployment operator creates this receipt from source and local built artifact identities. */
import { readPrivateJson } from './auth-state.ts'

/** Bind a private deployment receipt to this exact workspace snapshot and requested runtime. */
export async function verifyDeploymentRecord(
  path: string, workspace: string, source: { commit: string; workspaceSha256: string }, buildId: string,
): Promise<void> {
  const value = await readPrivateJson(path, workspace)
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('commit' in value) || value.commit !== source.commit || !('workspaceSha256' in value) || value.workspaceSha256 !== source.workspaceSha256 || !('buildId' in value) || value.buildId !== buildId) throw new Error('Deployment receipt does not match source and build')
}
