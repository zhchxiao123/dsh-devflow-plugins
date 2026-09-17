import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { installProjectHost, createProjectSession } from '../../../tests/automation-project-host.ts'
import { resolveProject, resolveSessionProject } from '../src/index.ts'

it('requires registered workspace ownership and resolves live and cold sessions to its stable identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automation-project-'))
  const ctx = new Context()
  try {
    await expect(resolveProject(ctx, undefined)).rejects.toThrow('PROJECT_CONTEXT_REQUIRED')
    await expect(resolveProject(ctx, root)).rejects.toThrow('WORKSPACE_SERVICE_UNAVAILABLE')
    await expect(resolveSessionProject(ctx, 'missing')).rejects.toThrow('SESSION_CONTEXT_UNAVAILABLE')
    await installProjectHost(ctx, root)
    await expect(resolveProject(ctx, root)).rejects.toThrow('PROJECT_NOT_REGISTERED')
    await expect(resolveSessionProject(ctx, 'missing')).rejects.toThrow('SESSION_NOT_FOUND')
    const { project, session } = await createProjectSession(ctx, join(root, 'project'), 'live', 'Registered project')
    expect(await resolveSessionProject(ctx, session.id)).toEqual({ id: project.id, title: project.title })
    const cold = ctx.sessions.prepare(SessionId('cold'), { meta: { cwd: project.path } })
    const handle = await ctx.sessionPersistence.create(cold.header)
    await handle.flush()
    await handle.close()
    expect(ctx.sessions.get(cold.id)).toBeUndefined()
    expect(await resolveSessionProject(ctx, cold.id)).toEqual({ id: project.id, title: project.title })
    await project.setTitle('Renamed')
    expect(await resolveProject(ctx, project.path)).toEqual({ id: project.id, title: 'Renamed' })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
