import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Approval from '@deepseek-ai/dsh-user-approval'
import Store from '@zhchxiao123/dsh-devflow-filesystem'
import { emptyInbox } from '../../../tests/agent-double.ts'
import { registerAuthTools } from '../src/auth-tools.ts'
import { registerProjectTools } from '../src/project-tools.ts'
import { readSettings, writeSettings } from '../src/project-settings.ts'
import { sha256, workspaceIdentity } from '../src/identity.ts'
import { projectOutput } from '../src/project-runtime.ts'
import { ValidatorRegistry } from '../../devflow-gates/src/validators.ts'
import type { Config } from '../src/config.ts'
vi.mock('../src/identity.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/identity.ts')>(), workspaceIdentity: vi.fn() }))
vi.mock('../src/project-runtime.ts', () => ({ projectOutput: vi.fn() }))
let ctx: Context
let dir: string
let root: string
let owner: Agent
let receipt: string
let approval: MockInstance<Approval['request']>
let disposeApproval: () => Promise<void>
let removeValidators: () => void
const SUITE = JSON.stringify({ version: 1, name: 'acceptance', baseUrl: 'http://localhost:3000/', buildProbe: { path: '/build', expected: 'build', format: 'json', field: ['buildId'], instanceField: ['instanceId'] }, cases: [{ id: 'one', steps: [{ kind: 'assert', prompt: 'visible' }] }] })
const config: Config = { profiles: {} }
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'midscene-project-tools-')))
  root = join(dir, 'workspace'); await mkdir(root)
  await mkdir(join(dir, 'output'))
  receipt = join(dir, 'deployment.json')
  await writeFile(receipt, JSON.stringify({ version: 1, commit: 'commit', workspaceSha256: 'hash', buildId: 'build' }), { mode: 0o600 })
  vi.mocked(workspaceIdentity).mockReset().mockResolvedValue({ commit: 'commit', workspaceSha256: 'hash' })
  vi.mocked(projectOutput).mockReset().mockResolvedValue(join(dir, 'output'))
  ctx = new Context()
  removeValidators = ctx.provide('devflowValidators', new ValidatorRegistry())
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(Agents).await(); await ctx.plugin(Tools).await()
  await ctx.plugin(Store, { root: join(root, '.devflow') }).await()
  const fiber = ctx.plugin(Approval, { policy: 'ask' }); await fiber.await()
  disposeApproval = async () => { await fiber.dispose() }
  approval = vi.spyOn(ctx.approval, 'request').mockResolvedValue('allowed-once')
  const id = SessionId('project-owner'); const base = Session.create(id)
  owner = { id, options: {}, session: Session.create(id, [], { ...base.header, cwd: root }), inbox: emptyInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx, followup() {}, steer() {}, inject() {}, send() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(owner)
  config.profiles = {}
  registerProjectTools(ctx, config)
  registerAuthTools(ctx)
  const card = join(root, '.devflow/tasks/0001-check'); await mkdir(card, { recursive: true })
  await writeFile(join(card, 'card.md'), '---\ntitle: Check\n---\n')
  await writeFile(join(card, 'journal.jsonl'), JSON.stringify({ rev: 1, at: 'now', type: 'created', by: { kind: 'human' } }) + '\n')
})
afterEach(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
async function call(
  name: string, args: Record<string, unknown> = {}, agent: Agent | undefined = owner,
): Promise<{ error: boolean; text: string }> {
  const result = await ctx.tools.execute({ name, arguments: args, ...(agent ? { agent } : {}), callId: ToolCallId('project-call'), signal: new AbortController().signal })
  return { error: result.isError, text: result.content.map(item => item.type === 'text' ? item.text : '').join('\n') }
}
const bind = (extra: Record<string, unknown> = {}) => call('midscene_bind', { card: '0001-check', suiteJson: SUITE, deploymentRecord: receipt, ...extra })
it('discovers without mutating and remembers portable settings through the real tool registry', async () => {
  expect((await call('midscene_discover')).text).toContain('unavailable')
  expect((await call('midscene_project', { settings: JSON.stringify({ targetUrl: 'http://localhost:3000' }) })).error).toBe(false)
  expect((await call('midscene_discover')).text).toContain('ready')
  expect((await call('midscene_project')).text).toContain('Choose settings')
  expect((await call('midscene_project', { settings: JSON.stringify({ suites: {} }) })).text).toContain('midscene_bind')
  expect((await call('midscene_project', { settings: JSON.stringify({ baseUrl: 'secret' }) })).error).toBe(true)
  const orphan = { ...owner, session: Session.create(SessionId('orphan')) }
  expect((await call('midscene_discover', {}, orphan)).text).toContain('owning workspace')
})
it('migrates only this workspace and strips runtime paths and credentials', async () => {
  config.profiles.local = { workspace: root, output: '/private', targetUrl: 'http://localhost:4000', model: 'vision', family: 'qwen3-vl', baseUrl: 'https://secret', provider: 'local', credentialRef: 'SECRET', browserMode: 'puppeteer', maxSteps: 30, timeoutMs: 180000, cleanupTimeoutMs: 10000 }
  expect((await call('midscene_project', { migrateProfile: 'local' })).error).toBe(false)
  expect(await readSettings(root)).toEqual({ targetUrl: 'http://localhost:4000/', model: { provider: 'local', model: 'vision', family: 'qwen3-vl' } })
  delete config.profiles.local.provider
  expect((await call('midscene_project', { migrateProfile: 'local' })).error).toBe(false)
  expect((await call('midscene_project', { migrateProfile: 'missing' })).text).toContain('does not belong')
  config.profiles.local.workspace = dir
  expect((await call('midscene_project', { migrateProfile: 'local' })).text).toContain('does not belong')
})
it('binds an approved suite, stores private receipt and enables card-specific completion gates', async () => {
  const first = await bind(); expect(first).toMatchObject({ error: false }); expect(first.text).toContain('Bound 0001-check')
  expect(approval).toHaveBeenCalledOnce()
  expect(approval.mock.calls[0]?.[0].reason).toContain(SUITE)
  const settings = await readSettings(root)
  expect(settings.suites?.['0001-check']).toMatchObject({ suiteSha256: sha256(SUITE), buildId: 'build' })
  const policy = JSON.parse(await readFile(join(root, '.devflow/validation.json'), 'utf8')) as { requirements: unknown[] }
  expect(policy.requirements).toHaveLength(1)
  expect(await readFile(join(root, '.devflow/midscene/suites/0001-check.json'), 'utf8')).toBe(SUITE)
  expect(await readFile(join(dir, 'output', `deployment-${sha256('0001-check')}.json`), 'utf8')).toContain('build')
  expect((await call('midscene_bind', { card: '0001-check', suiteJson: SUITE })).error).toBe(false)
  expect(approval).toHaveBeenCalledOnce()
  expect((await call('midscene_project', { settings: '{}' })).error).toBe(false)
  expect((await readSettings(root)).suites).toEqual(settings.suites)
})
it('binds existing suite files and preserves unrelated requirements', async () => {
  await writeFile(join(root, 'suite.json'), SUITE)
  await writeFile(join(root, '.devflow/validation.json'), JSON.stringify({ version: 1, requirements: [{ validators: ['other'] }] }))
  expect((await call('midscene_bind', { card: '0001-check', suite: 'suite.json', deploymentRecord: receipt })).error).toBe(false)
  expect(await readFile(join(root, '.devflow/validation.json'), 'utf8')).toContain('other')
})
it('refuses unavailable or denied approval and foreign or missing owners', async () => {
  approval.mockResolvedValue('rejected')
  expect((await bind()).text).toContain('approval required')
  const foreign = { ...owner, id: SessionId('foreign') }
  expect((await call('midscene_bind', { card: '0001-check', suiteJson: SUITE, deploymentRecord: receipt }, foreign)).text).toContain('live owning')
  expect((await bind({ card: '../escape' })).text).toContain('Invalid Devflow')
  await disposeApproval()
  expect((await bind()).text).toContain('approval required')
})
it('rejects missing, oversized, ambiguous or invalid suites before approval', async () => {
  expect((await call('midscene_bind', { card: '0001-check', deploymentRecord: receipt })).text).toContain('Choose suite')
  expect((await bind({ suite: 'suite.json' })).text).toContain('Choose suite')
  expect((await call('midscene_bind', { card: '0001-check', suite: 'missing.json', deploymentRecord: receipt })).text).toContain('not found')
  expect((await bind({ suiteJson: ' '.repeat(262145) })).text).toContain('size limit')
  expect((await bind({ suiteJson: '{}' })).error).toBe(true)
  expect(approval).not.toHaveBeenCalled()
})
it.each([null, {}, { version: 2, requirements: [] }, { version: 1 }, { version: 1, requirements: {} }])('fails closed for invalid policy %j', async (policy) => {
  await writeFile(join(root, '.devflow/validation.json'), JSON.stringify(policy))
  expect((await bind()).text).toContain('Invalid project validation')
  expect((await readSettings(root)).suites).toBeUndefined()
})
it('rechecks settings and source after waiting for approval', async () => {
  approval.mockImplementationOnce(async () => { await writeSettings(root, { app: 'changed' }); return 'allowed-once' })
  expect((await bind()).text).toContain('inputs changed')
  vi.mocked(workspaceIdentity).mockResolvedValueOnce({ commit: 'commit', workspaceSha256: 'hash' }).mockResolvedValueOnce({ commit: 'different', workspaceSha256: 'hash' })
  expect((await bind()).text).toContain('does not match')
})
it('rechecks existing suite bytes and card revision after approval', async () => {
  await writeFile(join(root, 'suite.json'), SUITE)
  approval.mockImplementationOnce(async () => { await writeFile(join(root, 'suite.json'), '{}'); return 'allowed-once' })
  expect((await call('midscene_bind', { card: '0001-check', suite: 'suite.json', deploymentRecord: receipt })).text).toContain('suite changed')
  const read = ctx.devflow.read.bind(ctx.devflow)
  vi.spyOn(ctx.devflow, 'read').mockImplementationOnce(read).mockImplementationOnce(async (...args) => ({ ...await read(...args), stageRevision: 2 }))
  expect((await bind()).text).toContain('inputs changed')
})

it('requires the completion gate engine before requesting approval', async () => {
  removeValidators()
  expect((await bind()).text).toContain('gate engine')
  expect(approval).not.toHaveBeenCalled()
})

it('uses configured step and timeout limits when binding acceptance', async () => {
  expect((await call('midscene_project', { settings: JSON.stringify({ limits: { maxSteps: 40, timeoutMs: 90000 } }) })).error).toBe(false)
  const suite = JSON.stringify({ version: 1, name: 'long acceptance', baseUrl: 'http://localhost:3000/', buildProbe: { path: '/build', expected: 'build', format: 'json', field: ['buildId'], instanceField: ['instanceId'] }, cases: [{ id: 'one', steps: Array.from({ length: 35 }, () => ({ kind: 'assert', prompt: 'visible' })) }] })
  expect((await bind({ suiteJson: suite })).error).toBe(false)
  expect(await readFile(join(root, '.devflow/validation.json'), 'utf8')).toContain('90000')
  expect((await call('midscene_project', { settings: JSON.stringify({ limits: { maxSteps: 40, timeoutMs: 120000 } }) })).error).toBe(false)
  expect((await bind({ suiteJson: suite })).error).toBe(false)
  const policy = JSON.parse(await readFile(join(root, '.devflow/validation.json'), 'utf8')) as { requirements: { timeoutMs: number }[] }
  expect(policy.requirements).toHaveLength(1)
  expect(policy.requirements[0]?.timeoutMs).toBe(120000)
})

it.each([
  { path: '/build', expected: 'build' },
  { path: '/build', expected: 'build', format: 'json', field: ['buildId'] },
])('rejects probes without runtime instance identity before approval or persistence', async (buildProbe) => {
  const suiteJson = JSON.stringify({ version: 1, name: 'acceptance', baseUrl: 'http://localhost:3000/', buildProbe,
    cases: [{ id: 'one', steps: [{ kind: 'assert', prompt: 'visible' }] }] })
  expect((await bind({ suiteJson })).text).toContain('JSON build probe with instanceField required for completion freshness')
  expect(approval).not.toHaveBeenCalled()
  expect(await readSettings(root)).toEqual({})
  await expect(readFile(join(root, '.devflow/validation.json'), 'utf8')).rejects.toThrow('ENOENT')
})

it('prepares login conversationally without persisting credentials in project settings', async () => {
  expect((await call('midscene_auth', { action: 'status' })).text).toContain('TARGET_REQUIRED')
  await writeSettings(root, { targetUrl: 'http://localhost:3000/', authentication: { required: true, role: 'reader' } })
  expect((await call('midscene_auth', { action: 'status' })).text).toContain('missing')
  expect((await call('midscene_auth', { action: 'import' })).text).toContain('LOGIN_FILE_REQUIRED')
  const snapshot = join(dir, 'login.json')
  await writeFile(snapshot, JSON.stringify({ cookies: [], origins: [{ origin: 'http://localhost:3000', localStorage: [{ name: 'session', value: 'private-token' }] }] }), { mode: 0o600 })
  const imported = await call('midscene_auth', { action: 'import', snapshotFile: snapshot, targetUrl: 'http://localhost:3000/' })
  expect(imported.error, imported.text).toBe(false)
  expect(imported.text).toContain('available'); expect(imported.text).not.toContain('private-token')
  expect(JSON.stringify(await readSettings(root))).not.toContain('private-token')
  expect((await call('midscene_auth', { action: 'clear' })).text).toContain('missing')
  await writeSettings(root, { targetUrl: 'http://localhost:3000/' })
  expect((await call('midscene_auth', { action: 'status' })).text).toContain('"required":false')
})
it('requires an owning workspace for login preparation', async () => {
  const result = await ctx.tools.execute({ name: 'midscene_auth', arguments: { action: 'status' }, callId: ToolCallId('no-auth-owner'), signal: new AbortController().signal })
  expect(result.isError).toBe(true)
})
