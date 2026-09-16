import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordPreflight, registerSummary } from '../src/summary.ts'
import type { AcceptanceProfile } from '../src/config.ts'
let ctx: Context
let root: string
let p: AcceptanceProfile
const id = SessionId('summary-owner')
const runId = '00000000-0000-0000-0000-000000000001'
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'midscene-summary-')))
  await mkdir(join(root, 'workspace'))
  p = { workspace: join(root, 'workspace'), output: join(root, 'output'), model: 'vision', family: 'glm-v',
    baseUrl: 'https://model.test', targetUrl: 'http://localhost:3000', browserMode: 'puppeteer', timeoutMs: 1000, cleanupTimeoutMs: 100, maxSteps: 3,
    suiteSha256: 'approved', suite: 'suite.json', buildId: 'build', deploymentRecord: join(root, 'receipt.json'), reportBaseUrl: 'http://localhost:3082' }
  ctx = new Context()
  await ctx.plugin(SessionStore).await()
  ctx.sessions.create(id, { meta: { cwd: p.workspace } })
  registerSummary(ctx, { profiles: { local: p } })
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
const read = () => ctx.devflowMidsceneSummary.read(id, '0001-card')
async function json(path: string, value: unknown) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value), { mode: 0o600 }) }
function manifest(over: Record<string, unknown> = {}) {
  return { runId, card: '0001-card', status: 'passed', startedAt: '2026-09-15T00:00:00Z',
    identity: { workspace: p.workspace, model: p.model, suiteSha256: p.suiteSha256 }, ...over }
}
it('projects only configured diagnostics, never credentials or model endpoint', async () => {
  p.credentialRef = 'secret-ref'
  expect(await read()).toMatchObject({ available: true, jobs: [], gateEngineAvailable: false, profiles: [{ name: 'local', login: 'none', formalConfigured: true }] })
  expect(JSON.stringify(await read())).not.toMatch(/secret-ref|model.test|receipt.json/)
  await recordPreflight(p, 'local', 'available')
  expect((await read()).profiles[0]?.preflight).toMatchObject({ model: 'available' })
  await recordPreflight(p, 'local', 'unknown')
  expect((await read()).profiles[0]?.preflight?.model).toBe('unknown')
  p.model = 'changed'
  expect((await read()).profiles[0]?.preflight).toBeUndefined()
})
it('rejects workspace-contained diagnostic writes', async () => {
  p.output = join(p.workspace, 'private')
  await expect(recordPreflight(p, 'local', 'unavailable')).rejects.toThrow('outside workspace')
})
it('reads persisted session identity and never enumerates unowned jobs', async () => {
  ctx.provide('sessionPersistence', { stat: async (session: string) => session === 'persisted' ? { header: { cwd: p.workspace } } : undefined })
  expect((await ctx.devflowMidsceneSummary.read('persisted', '0001-card')).profiles).toHaveLength(1)
  ctx.provide('agents', { get: () => ({ session: { header: { cwd: p.workspace } } }) })
  expect((await ctx.devflowMidsceneSummary.read('agent-only', '0001-card')).jobs).toEqual([])
  ctx.provide('devflowValidators', { register: () => () => {} })
  expect((await read()).gateEngineAvailable).toBe(true)
})
it('ignores another workspace and unknown sessions', async () => {
  await mkdir(join(root, 'other')); p.workspace = join(root, 'other')
  expect((await read()).profiles).toEqual([])
  await expect(ctx.devflowMidsceneSummary.read('missing', '0001-card')).rejects.toThrow('Unknown session')
  ctx.sessions.create(SessionId('no-cwd'))
  await expect(ctx.devflowMidsceneSummary.read('no-cwd', '0001-card')).rejects.toThrow('Unknown session')
})
it.each(['cdp', 'bridge'] as const)('shows borrowed %s and incomplete formal config', async (browserMode) => {
  p.browserMode = browserMode; delete p.suite
  expect((await read()).profiles[0]).toMatchObject({ login: 'borrowed', formalConfigured: false })
  p.storageState = '/private/state.json'
  expect((await read()).profiles[0]?.login).toBe('snapshot')
})
it('reads latest scoped formal run, maps running to unknown and uses only configured report host', async () => {
  await json(join(p.output, runId, 'manifest.json'), manifest())
  expect((await read()).profiles[0]?.latestRun).toMatchObject({ status: 'passed', runId, reportUrl: `http://localhost:3082/devflow/reports/${id}/${runId}/test-report.md` })
  delete p.reportBaseUrl
  await json(join(p.output, runId, 'manifest.json'), manifest({ status: 'running' }))
  expect((await read()).profiles[0]?.latestRun).toEqual({ status: 'unknown', runId, at: '2026-09-15T00:00:00Z' })
  const older = '00000000-0000-0000-0000-000000000002'
  await json(join(p.output, older, 'manifest.json'), manifest({ runId: older, startedAt: '2026-09-14T00:00:00Z' }))
  expect((await read()).profiles[0]?.latestRun?.runId).toBe(runId)
  const newer = '00000000-0000-0000-0000-000000000003'
  await json(join(p.output, newer, 'manifest.json'), manifest({ runId: newer, startedAt: '2026-09-16T00:00:00Z' }))
  expect((await read()).profiles[0]?.latestRun?.runId).toBe(newer)
})
it.each([null, false, [], { runId: 'foreign' }, { runId, card: 'other' }])('ignores invalid or foreign records %j', async (value) => {
  await json(join(p.output, runId, 'manifest.json'), value)
  expect((await read()).profiles[0]?.latestRun).toBeUndefined()
})
it.each(['workspace', 'model', 'suiteSha256'])('refuses mismatched run identity %s', async (field) => {
  await json(join(p.output, runId, 'manifest.json'), manifest({ identity: { workspace: p.workspace, model: p.model, suiteSha256: p.suiteSha256, [field]: 'different' } }))
  expect((await read()).profiles[0]?.latestRun).toBeUndefined()
})
it('ignores malformed identity instead of hiding healthy profile configuration', async () => {
  await json(join(p.output, runId, 'manifest.json'), manifest({ identity: null }))
  expect((await read()).profiles[0]?.latestRun).toBeUndefined()
})
it.each([{ startedAt: 42 }, { status: 'made-up' }])('refuses invalid run metadata %j', async (over) => {
  await json(join(p.output, runId, 'manifest.json'), manifest(over))
  expect((await read()).profiles[0]?.latestRun).toBeUndefined()
})
it('refuses symlinked records and ignores non-run files', async () => {
  await json(join(p.output, 'original.json'), manifest())
  await mkdir(join(p.output, runId)); await symlink(join(p.output, 'original.json'), join(p.output, runId, 'manifest.json'))
  expect((await read()).profiles[0]?.latestRun).toBeUndefined()
})
it.each(['workspace', 'profile', 'modelId', 'family', 'at', 'model'])('ignores invalid persisted preflight %s', async (field) => {
  await json(join(p.output, 'local.preflight.json'), { workspace: p.workspace, profile: 'local', modelId: p.model, family: p.family, at: 'now', model: 'available', [field]: field === 'at' ? 42 : 'invalid' })
  expect((await read()).profiles[0]?.preflight).toBeUndefined()
})
