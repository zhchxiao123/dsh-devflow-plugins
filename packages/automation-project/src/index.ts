/** Project identity comes only from an existing Harness workspace registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'

export async function resolveProject(ctx: Context, cwd: string | undefined): Promise<{ id: string; title: string }> {
  if (!cwd) throw new Error('PROJECT_CONTEXT_REQUIRED')
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) throw new Error('WORKSPACE_SERVICE_UNAVAILABLE')
  const workspace = await registry.resolveByPath(cwd)
  if (workspace === undefined) throw new Error('PROJECT_NOT_REGISTERED')
  return { id: workspace.id, title: workspace.title }
}

/** Cold sessions resolve through persistence without materializing an agent. */
export async function resolveSessionProject(ctx: Context, sessionId: string): Promise<{ id: string; title: string }> {
  const id = sessionId as SessionId
  const live = ctx.get('sessions')?.get(id)
  if (live !== undefined) return resolveProject(ctx, live.header.cwd)
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('SESSION_CONTEXT_UNAVAILABLE')
  const snapshot = await persistence.stat(id)
  if (snapshot === undefined) throw new Error('SESSION_NOT_FOUND')
  return resolveProject(ctx, snapshot.header.cwd)
}
