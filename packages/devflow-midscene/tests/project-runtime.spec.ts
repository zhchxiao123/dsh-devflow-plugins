import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { emptyInbox } from '../../../tests/agent-double.ts'
import { projectOutput, projectHistoryProfile, resolveProjectProfile } from '../src/project-runtime.ts'
import { writeSettings } from '../src/project-settings.ts'
import { sha256 } from '../src/identity.ts'

let root: string
let workspace: string
let owner: Agent
let ctx: Context
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'midscene-project-runtime-')))
  workspace = join(root, 'project'); await mkdir(workspace)
  vi.stubEnv('DSH_HOME', join(root, 'host'))
  ctx = new Context()
  const id = SessionId('runtime-owner'); const base = Session.create(id)
  owner = { id, ctx, session: Session.create(id, [], { ...base.header, cwd: workspace }), options: {}, status: 'idle', inbox: emptyInbox(),
    followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
})
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
})
it('isolates output by canonical worktree and resolves history without model or target', async () => {
  const output = await projectOutput(workspace)
  expect(output).toBe(join(root, 'host', 'midscene', 'projects', sha256(workspace)))
  const other = join(root, 'other'); await mkdir(other)
  expect(await projectOutput(other)).not.toBe(output)
  expect(await projectHistoryProfile(owner)).toMatchObject({ workspace, output, modelSource: 'dsh' })
})
it('refuses absent session cwd and host storage inside the repository', async () => {
  const base = Session.create(owner.id)
  await expect(projectHistoryProfile({ ...owner, session: base })).rejects.toThrow('owning workspace')
  vi.stubEnv('DSH_HOME', workspace)
  await expect(projectOutput(workspace)).rejects.toThrow('PRIVATE_STORAGE_REQUIRED')
})
it('refuses symlinked private output before producing evidence', async () => {
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, join(root, 'host'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(projectOutput(workspace)).rejects.toThrow('ALIASED')
})
it('discovers a static target, freezes initiating model, and allows explicit invocation target', async () => {
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 4321' } }))
  vi.spyOn(owner.session, 'requestHeader').mockReturnValue({ config: { provider: 'existing', model: 'gpt-5' } })
  expect(await resolveProjectProfile(owner)).toMatchObject({ targetUrl: 'http://localhost:4321/', provider: 'existing', model: 'gpt-5', family: 'gpt-5' })
  expect(await resolveProjectProfile(owner, { targetUrl: 'http://localhost:5432', app: '.' })).toMatchObject({ targetUrl: 'http://localhost:5432/' })
})
it('keeps ambiguity and missing model actionable without inventing defaults', async () => {
  await expect(resolveProjectProfile(owner)).rejects.toThrow('TARGET_UNAVAILABLE')
  await expect(resolveProjectProfile(owner, { targetUrl: 'http://localhost:1234' })).rejects.toThrow('MODEL_NOT_CONFIGURED')
  vi.spyOn(owner.session, 'requestHeader').mockReturnValue({ config: { provider: 'gateway', model: 'alias' } })
  await expect(resolveProjectProfile(owner, { targetUrl: 'http://localhost:1234' })).rejects.toThrow('MODEL_FAMILY_UNKNOWN')
})
it('uses remembered model references and binds private receipt to an approved card', async () => {
  const suite = { version: 1, name: 'card', baseUrl: 'http://localhost:2345', buildProbe: { path: '/build', expected: 'build-1' }, cases: [{ id: 'one', steps: [{ kind: 'assert', prompt: 'Welcome visible' }] }] }
  const bytes = JSON.stringify(suite); await writeFile(join(workspace, 'acceptance.json'), bytes)
  await writeSettings(workspace, { model: { provider: 'existing', model: 'alias', family: 'gpt-5' }, suites: { '0001-card': { suite: 'acceptance.json', suiteSha256: sha256(bytes), buildId: 'build-1' } } })
  const resolved = await resolveProjectProfile(owner, {}, '0001-card')
  expect(resolved).toMatchObject({ targetUrl: 'http://localhost:2345/', suite: 'acceptance.json', model: 'alias', buildId: 'build-1', suiteSha256: sha256(bytes), deploymentRecord: join(await projectOutput(workspace), `deployment-${sha256('0001-card')}.json`) })
  expect(resolved.projectSettingsHash).toMatch(/^[a-f0-9]{64}$/)
  await expect(resolveProjectProfile(owner, {}, '0002-missing')).rejects.toThrow('TARGET_UNAVAILABLE')
})
