/* oxlint-disable @stylistic/max-len */
/** Real Loader, HTTP, session ownership, job registry, tools, and durable Devflow store. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionRegistry, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import * as JevRunsPlugin from '../../jev/src/runs-plugin.ts'
import * as DevflowJevPlugin from '../src/index.ts'
import { emptyInbox } from '../../../tests/agent-double.ts'

class FixtureJev extends JevRuntime {
  protected perform(_request: JevRequest): Promise<JevResponse> { return Promise.resolve({ model: 'fixture', answers: {
    codeSolvable: { type: 'noul', noul: 0.9 }, informationSufficient: { type: 'noul', noul: 0.9 }, value: { type: 'score', score: 3, probabilities: [0, 0, 0, 1, 0], confidence: 1 }, risk: { type: 'score', score: 1, probabilities: [0, 1, 0, 0, 0], confidence: 1 }, scopeClarity: { type: 'score', score: 3, probabilities: [0, 0, 0, 1, 0], confidence: 1 }, recommendedAction: { type: 'choice', choice: 'create', probabilities: { create: 1, investigate: 0, ask: 0, reject: 0 }, confidence: 1 }, serviceClass: { type: 'choice', choice: 'standard', probabilities: { standard: 1, express: 0, emergency: 0 }, confidence: 1 },
  } }) }
}
let context: Context | undefined; let directory: string | undefined
afterEach(async () => { await context?.fiber.dispose(); if (directory !== undefined) await rm(directory, { recursive: true, force: true }); context = undefined; directory = undefined })

function owner(ctx: Context, name: string, cwd: string): Agent {
  const id = SessionId(name); const session = ctx.sessions.create(id, { meta: { cwd } }); const scope = ctx.plugin(() => {})
  const value: Agent = { id, options: {}, session, inbox: emptyInbox(), status: 'idle', ctx: scope.ctx, followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(value); return value
}
function post(port: number, value: unknown): Promise<{ status: number; value: unknown }> { return new Promise((resolve, reject) => { const body = JSON.stringify(value); const req = request({ host: '127.0.0.1', port, path: '/devflow/jev/api', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { let text = ''; res.on('data', (chunk) => { text += String(chunk) }); res.on('end', () => { let parsed: unknown = text; try { parsed = JSON.parse(text) as unknown } catch {} resolve({ status: res.statusCode ?? 0, value: parsed }) }) }); req.on('error', reject); req.end(body) }) }

it('runs an owner-scoped project audit through real Loader, HTTP, jobs, and storage, then disposes its surfaces', async () => {
  directory = await mkdtemp(join(tmpdir(), 'devflow-jev-loader-')); const devflowRoot = join(directory, '.devflow'); const config = join(directory, 'cordis.yml')
  await writeFile(config, [
    '- name: fixture-system-prompt', "- name: '@deepseek-ai/dsh-session'", "- name: '@deepseek-ai/dsh-agent'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-jobs-local'", '- name: fixture-controller', "- name: '@deepseek-ai/dsh-host-webserver'", '  config:', '    host: 127.0.0.1', '    port: 0', "- name: '@zhchxiao123/dsh-devflow-filesystem'", '  config:', `    root: ${JSON.stringify(devflowRoot)}`, '- name: fixture-jev', "- name: '@zhchxiao123/dsh-jev/runs-plugin'", "- name: '@zhchxiao123/dsh-devflow-jev'", '',
  ].join('\n'))
  const ctx = new Context(); context = ctx; ctx.baseUrl = pathToFileURL(directory).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const systemPrompt = { name: 'fixture-system-prompt', apply(child: Context) { child.effect(() => child.provide('systemPrompt', { tools: () => () => {} })) } }
  const controller = { name: 'fixture-controller', inject: ['jobs'], apply(child: Context) { child.effect(() => child.jobs.attachController('jev-loader-test')) } }
  const modules = new Map<string, unknown>([['fixture-system-prompt', systemPrompt], ['@deepseek-ai/dsh-session', SessionRegistry], ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-tools', ToolRuntime], ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry], ['fixture-controller', controller], ['@deepseek-ai/dsh-host-webserver', WebServer], ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore], ['fixture-jev', FixtureJev], ['@zhchxiao123/dsh-jev/runs-plugin', JevRunsPlugin], ['@zhchxiao123/dsh-devflow-jev', DevflowJevPlugin]])
  ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error(`unexpected import ${name}`); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
  const agent = owner(ctx, 'jev-owner', directory); const foreign = owner(ctx, 'jev-foreign', directory)
  if (ctx.get('devflowJev') === undefined) throw new Error(`missing devflowJev: devflow=${String(ctx.get('devflow') !== undefined)} jev=${String(ctx.get('jev') !== undefined)} tools=${String(ctx.get('tools') !== undefined)} web=${String(ctx.get('webServer') !== undefined)} entries=${[...ctx.loader.entries()].map(entry => `${entry.options.name}:${entry.status}`).join(',')}`)
  const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root: devflowRoot, title: 'Audit integration', body: 'Acceptance criteria.', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
  const response = await post(ctx.webServer.port, { method: 'audit-start', sessionId: agent.id, profile: 'delivery-health', maxCards: 10 })
  expect(response.status).toBe(200); const envelope = response.value as { ok: boolean; data: { manifest: { id: string }; jobId: string } }; expect(envelope.ok).toBe(true)
  expect(ctx.jobs.list(agent).map(job => job.id)).toContain(envelope.data.jobId); expect(ctx.jobs.list(foreign)).toHaveLength(0)
  await expect(ctx.jobs.wait(JobId(envelope.data.jobId), 2000, agent)).resolves.toMatchObject({ status: 'completed', ownerSession: agent.id })
  expect(() => ctx.jobs.get(JobId(envelope.data.jobId), foreign)).toThrow()
  const detail = await post(ctx.webServer.port, { method: 'audit-read', sessionId: agent.id, runId: envelope.data.manifest.id }); expect(detail.value).toMatchObject({ ok: true, data: { state: { status: 'completed', jobId: envelope.data.jobId } } })
  expect(ctx.tools.get('devflow_audit_project')).toBeDefined()
  expect(ctx.tools.get('jev_start_run')).toBeDefined(); expect(ctx.tools.get('jev_runs')).toBeDefined()
  const plugin = [...ctx.loader.entries()].find(entry => entry.options.name === '@zhchxiao123/dsh-devflow-jev'); if (!plugin?.fiber) throw new Error('plugin missing'); await plugin.fiber.dispose()
  expect(ctx.tools.get('devflow_audit_project')).toBeUndefined(); expect((await post(ctx.webServer.port, { method: 'audit-list', sessionId: agent.id })).status).toBe(404)
})
