/* oxlint-disable @stylistic/max-len */
/** Real Loader, HTTP, session ownership, job registry, tools, and durable Devflow store. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionRegistry, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevRequest, JevResponse, JevRunDefinition } from '@zhchxiao123/dsh-jev'
import * as JevRunsPlugin from '../../jev/src/runs-plugin.ts'
import * as DevflowJevPlugin from '../src/index.ts'
import { AssistanceStore } from '../src/assistance-store.ts'
import type { AssistanceRecord } from '../src/assistance-types.ts'
import { emptyInbox } from '../../../tests/agent-double.ts'

class FixtureJev extends JevRuntime {
  private waiting = false
  protected perform(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    if (request.state === 'wait-for-cancel' && !this.waiting) {
      this.waiting = true
      return new Promise((_resolve, reject) => { if (signal?.aborted === true) reject(new Error('cancelled')); else signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true }) })
    }
    return Promise.resolve({ model: 'fixture', answers: {
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
  const systemPrompt = SystemPrompt
  const controller = { name: 'fixture-controller', inject: ['jobs'], apply(child: Context) { child.effect(() => child.jobs.attachController('jev-loader-test')) } }
  const modules = new Map<string, unknown>([['fixture-system-prompt', systemPrompt], ['@deepseek-ai/dsh-session', SessionRegistry], ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-tools', ToolRuntime], ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry], ['fixture-controller', controller], ['@deepseek-ai/dsh-host-webserver', WebServer], ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore], ['fixture-jev', FixtureJev], ['@zhchxiao123/dsh-jev/runs-plugin', JevRunsPlugin], ['@zhchxiao123/dsh-devflow-jev', DevflowJevPlugin]])
  ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error(`unexpected import ${name}`); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
  const agent = owner(ctx, 'jev-owner', directory); const foreign = owner(ctx, 'jev-foreign', directory)
  if (ctx.get('devflowJev') === undefined) throw new Error(`missing devflowJev: devflow=${String(ctx.get('devflow') !== undefined)} jev=${String(ctx.get('jev') !== undefined)} tools=${String(ctx.get('tools') !== undefined)} web=${String(ctx.get('webServer') !== undefined)} entries=${[...ctx.loader.entries()].map(entry => entry.options.name).join(',')}`)
  const configuration = vi.spyOn(ctx.jev, 'configurationStatus').mockResolvedValue('configured')
  const guidance = renderContextSections(await ctx.systemPrompt.assemble(assembleContextFor(agent)))
  expect(guidance.find(section => section.name === 'jev-usage')?.text).toContain('Use JEV proactively')
  expect(guidance.find(section => section.name === 'devflow-jev-usage')?.text).toContain('target=request')
  configuration.mockRestore()
  const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root: devflowRoot, title: 'Audit integration', body: 'Acceptance criteria.', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
  const response = await post(ctx.webServer.port, { method: 'audit-start', sessionId: agent.id, profile: 'delivery-health', maxCards: 10 })
  expect(response.status).toBe(200); const envelope = response.value as { ok: boolean; data: { manifest: { id: string }; jobId: string } }; expect(envelope.ok).toBe(true)
  expect(ctx.jobs.list(agent).map(job => job.id)).toContain(envelope.data.jobId); expect(ctx.jobs.list(foreign)).toHaveLength(0)
  await expect(ctx.jobs.wait(JobId(envelope.data.jobId), 2000, agent)).resolves.toMatchObject({ status: 'completed', ownerSession: agent.id })
  expect(() => ctx.jobs.get(JobId(envelope.data.jobId), foreign)).toThrow()
  const detail = await post(ctx.webServer.port, { method: 'audit-read', sessionId: agent.id, runId: envelope.data.manifest.id }); expect(detail.value).toMatchObject({ ok: true, data: { state: { status: 'completed', jobId: envelope.data.jobId } } })
  for (const name of ['jev_run', 'jev_list', 'jev_control', 'devflow_assess', 'devflow_decide_judgement']) expect(ctx.tools.get(name)).toBeDefined()
  for (const name of ['jev_start_run', 'jev_runs', 'jev_resume_run', 'jev_cancel_run', 'devflow_assess_request', 'devflow_judgements', 'devflow_accept_judgement', 'devflow_reject_judgement', 'devflow_audit_project', 'devflow_audits', 'devflow_resume_audit', 'devflow_cancel_audit']) expect(ctx.tools.get(name)).toBeUndefined()
  expect((await post(ctx.webServer.port, { method: 'context', sessionId: agent.id })).value).toEqual({ ok: true, data: { projectName: basename(directory), projectPath: directory, genericRunsAvailable: true, assistanceAvailable: true, assistanceMode: 'observe' } })
  const assistanceRecord: AssistanceRecord = {
    id: '18c32e66-4976-4d89-aa94-d429e2cb1d10', workspace: directory, sessionId: agent.id, turn: 1,
    card: { id: created.card.id, revision: created.card.stageRevision, stage: created.card.stage, title: created.card.title },
    event: 'completion', mode: 'observe', evidenceDigest: 'fixture', policyVersion: '1',
    action: 'add-verification', reason: 'Restart behavior has no evidence', evidenceRefs: ['src/store.ts'], gaps: ['Restart test missing'],
    confidence: 0.8, status: 'observed', outcome: 'unknown', elapsedMs: 12,
    createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
  }
  await new AssistanceStore().write(directory, assistanceRecord)
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: agent.id, root: '/ignored' })).value).toEqual({ ok: true, data: [assistanceRecord] })
  expect((await post(ctx.webServer.port, { method: 'assistance-read', sessionId: agent.id, id: assistanceRecord.id })).value).toEqual({ ok: true, data: assistanceRecord })
  expect(await ctx.jevRuns.list(directory, { source: 'devflow-assistance', id: assistanceRecord.id })).toEqual([{ source: 'devflow-assistance', id: assistanceRecord.id, record: assistanceRecord }])
  await expect(ctx.jevRuns.list(directory, { source: 'devflow-assistance', id: '../outside' })).rejects.toThrow('invalid assistance id')
  const genericRoot = join(directory, '.jev')
  const definition: JevRunDefinition = { id: 'repository-review', scope: { kind: 'repository', id: directory, title: 'Repository review' }, template: { id: 'test-review', version: '1' }, createdAt: '2026-09-22T00:00:00.000Z', checks: [{ id: 'readme', subject: { kind: 'file', id: 'README.md', title: 'README' }, evidenceDigest: 'fixture', request: { state: 'wait-for-cancel', questions: { codeSolvable: { type: 'noul', instructions: 'Can this be solved in code?' } } } }] }
  await ctx.jevRuns.durable.prepare(genericRoot, definition)
  expect((await post(ctx.webServer.port, { method: 'run-list', sessionId: agent.id, root: '/ignored' })).value).toMatchObject({ ok: true, data: [{ definition, state: { status: 'interrupted' } }] })
  expect((await post(ctx.webServer.port, { method: 'run-read', sessionId: agent.id, runId: definition.id })).value).toMatchObject({ ok: true, data: { definition, state: { completed: 0 } } })
  expect((await post(ctx.webServer.port, { method: 'run-read', sessionId: agent.id, runId: '../outside' })).value).toMatchObject({ ok: false, error: 'dsh-jev: invalid run id' })
  const dormant = ctx.sessions.create(SessionId('jev-dormant'), { meta: { cwd: directory } })
  expect((await post(ctx.webServer.port, { method: 'run-resume', sessionId: dormant.id, runId: definition.id })).value).toEqual({ ok: false, error: 'LIVE_SESSION_REQUIRED: start, resume, and cancel require the live owning agent' })
  const competing = await Promise.all([post(ctx.webServer.port, { method: 'run-resume', sessionId: agent.id, runId: definition.id }), post(ctx.webServer.port, { method: 'run-resume', sessionId: agent.id, runId: definition.id })])
  const resumedValues = competing.map(response => response.value as { ok: boolean; data: { runId: string; jobId: string } })
  expect(resumedValues.filter(value => value.ok)).toHaveLength(1)
  const started = resumedValues.find(value => value.ok)
  if (started === undefined) throw new Error('resume did not start')
  expect(started.ok).toBe(true)
  await expect.poll(async () => (await ctx.jevRuns.durable.inspect(genericRoot, definition.id)).state.status).toBe('running')
  expect(ctx.jobs.list(agent).map(job => job.id)).toContain(started.data.jobId)
  expect((await post(ctx.webServer.port, { method: 'run-resume', sessionId: agent.id, runId: definition.id })).value).toEqual({ ok: false, error: 'dsh-jev: run repository-review cannot resume from running' })
  expect((await post(ctx.webServer.port, { method: 'run-cancel', sessionId: foreign.id, runId: definition.id })).value).toMatchObject({ ok: false })
  expect((await post(ctx.webServer.port, { method: 'run-cancel', sessionId: dormant.id, runId: definition.id })).value).toEqual({ ok: false, error: 'LIVE_SESSION_REQUIRED: start, resume, and cancel require the live owning agent' })
  expect((await ctx.jevRuns.durable.inspect(genericRoot, definition.id)).state.status).toBe('running')
  expect((await post(ctx.webServer.port, { method: 'run-cancel', sessionId: agent.id, runId: definition.id })).value).toMatchObject({ ok: true, data: { runId: definition.id, outcome: 'requested' } })
  await expect(ctx.jobs.wait(JobId(started.data.jobId), 2000, agent)).resolves.toMatchObject({ status: 'killed', ownerSession: agent.id })
  await expect.poll(async () => (await ctx.jevRuns.durable.inspect(genericRoot, definition.id)).state.status).toBe('cancelled')
  const resumed = (await post(ctx.webServer.port, { method: 'run-resume', sessionId: agent.id, runId: definition.id })).value as { ok: boolean; data: { jobId: string } }
  expect(resumed.ok).toBe(true)
  await expect(ctx.jobs.wait(JobId(resumed.data.jobId), 2000, agent)).resolves.toMatchObject({ status: 'completed', ownerSession: agent.id })
  expect((await post(ctx.webServer.port, { method: 'run-read', sessionId: agent.id, runId: definition.id })).value).toMatchObject({ ok: true, data: { state: { status: 'completed', completed: 1, jobId: resumed.data.jobId } } })
  const otherProject = owner(ctx, 'jev-other-project', join(directory, 'other'))
  expect((await post(ctx.webServer.port, { method: 'assistance-list', sessionId: otherProject.id })).value).toEqual({ ok: true, data: [] })
  expect((await post(ctx.webServer.port, { method: 'assistance-read', sessionId: otherProject.id, id: assistanceRecord.id })).value).toMatchObject({ ok: false })
  expect((await post(ctx.webServer.port, { method: 'run-list', sessionId: otherProject.id })).value).toEqual({ ok: true, data: [] })
  expect((await post(ctx.webServer.port, { method: 'run-read', sessionId: agent.id })).status).toBe(400)
  const createdRun = await ctx.jevRuns.start(genericRoot, { ...definition, id: 'empty-run', checks: [] }, agent)
  await expect(ctx.jobs.wait(JobId(createdRun.jobId), 2000, agent)).resolves.toMatchObject({ status: 'completed' })
  const failedBinding = vi.spyOn(ctx.jevRuns.durable, 'bindJob').mockRejectedValueOnce(new Error('binding write failed'))
  await expect(ctx.jevRuns.start(genericRoot, { ...definition, id: 'binding-failure' }, agent)).rejects.toThrow('binding write failed')
  failedBinding.mockRestore()
  const failedJob = ctx.jobs.list(agent).find(job => job.label === 'JEV run binding-failure')
  if (failedJob === undefined) throw new Error('failed binding job missing')
  await expect(ctx.jobs.wait(failedJob.id, 2000, agent)).resolves.toMatchObject({ status: 'killed' })
  const invoke = async (name: string, args: object) => {
    const result = await ctx.tools.execute({ name, arguments: args, agent, signal: new AbortController().signal, callId: ToolCallId('jev-simplification') })
    return { isError: result.isError, text: result.content.map(item => item.type === 'text' ? item.text : '').join('') }
  }
  const priorCount = (await ctx.devflowJev.list(devflowRoot)).length
  for (const args of [{ target: 'request', title: 'Mixed', body: 'Body', id: created.card.id }, { target: 'card', id: created.card.id }, { target: 'request', title: '', body: 'Body' }]) {
    expect((await invoke('devflow_assess', args)).isError).toBe(true)
  }
  expect(await ctx.devflowJev.list(devflowRoot)).toHaveLength(priorCount)
  expect((await post(ctx.webServer.port, { method: 'assess', sessionId: agent.id, title: 'Mixed', body: 'Body', id: created.card.id })).status).toBe(400)
  expect((await post(ctx.webServer.port, { method: 'assess-card', sessionId: agent.id, id: created.card.id, assessmentKind: 'planning', title: 'Mixed' })).status).toBe(400)
  expect((await post(ctx.webServer.port, { method: 'run-start', sessionId: agent.id, title: 'Wrong source', source: 'devflow-audit' })).status).toBe(400)
  expect((await invoke('devflow_assess', { target: 'request', title: 'Request from tool', body: 'Concrete acceptance.' })).isError).not.toBe(true)
  const proposed = (await ctx.devflowJev.list(devflowRoot)).find(value => value.subject.title === 'Request from tool')
  if (proposed === undefined) throw new Error('proposal missing')
  expect((await invoke('jev_list', { source: 'devflow-assessment', id: proposed.id })).text).toContain('Concrete acceptance.')
  expect((await invoke('devflow_decide_judgement', { id: proposed.id, action: 'accept' })).isError).not.toBe(true)
  expect((await invoke('devflow_decide_judgement', { id: proposed.id, action: 'accept' })).isError).not.toBe(true)
  expect((await ctx.devflow.list(undefined, devflowRoot)).filter(card => card.title === 'Request from tool')).toHaveLength(1)
  expect((await post(ctx.webServer.port, { method: 'assess-card', sessionId: agent.id, id: created.card.id, assessmentKind: 'planning' })).value).toMatchObject({ ok: true, data: { subject: { kind: 'card', cardId: created.card.id }, assessmentKind: 'planning' } })
  expect((await post(ctx.webServer.port, { method: 'assess-card', sessionId: agent.id, id: created.card.id, assessmentKind: 'invalid' })).status).toBe(400)
  expect((await post(ctx.webServer.port, { method: 'run-start', sessionId: agent.id, title: 'Simple review', evidence: 'Supplied evidence', questions: ['Can this be solved in code?'] })).value).toMatchObject({ ok: true, data: { definition: { scope: { title: 'Simple review' } } } })
  expect((await post(ctx.webServer.port, { method: 'run-start', sessionId: agent.id, definitionJson: '{}', title: 'Mixed' })).value).toMatchObject({ ok: false })
  const aggregate = await ctx.jevRuns.list(directory)
  expect(new Set(aggregate.map(value => value.source))).toEqual(new Set(['generic', 'devflow-audit', 'devflow-assessment', 'devflow-assistance']))
  expect(await ctx.jevRuns.list(join(directory, 'other'), { source: 'devflow-assessment' })).toEqual([])
  await expect(ctx.jevRuns.list(directory, { source: 'devflow-assessment', id: '../outside' })).rejects.toThrow('invalid evaluation id')
  expect((await invoke('jev_run', { source: 'devflow-audit', profile: 'risk', maxCards: 1 })).isError).not.toBe(true)
  expect((await invoke('jev_run', { source: 'devflow-assessment', title: 'Wrong route' })).isError).toBe(true)
  expect((await invoke('jev_run', { source: 'devflow-audit', title: 'Irrelevant field' })).isError).toBe(true)
  const failedAuditBinding = vi.spyOn(ctx.devflowJev, 'bindAuditJob').mockRejectedValueOnce(new Error('audit binding failed'))
  await expect(ctx.devflowJev.startAudit(devflowRoot, { profile: 'spec' }, agent)).rejects.toThrow('audit binding failed')
  failedAuditBinding.mockRestore()
  await expect.poll(() => ctx.jobs.list(agent).filter(job => job.label.startsWith('JEV project audit')).some(job => job.status === 'killed')).toBe(true)
  for (const job of ctx.jobs.list(agent)) await ctx.jobs.wait(job.id, 2000, agent)
  const stalled = await ctx.devflowJev.prepareAudit({ root: devflowRoot, profile: 'spec', maxCards: 1 })
  const ask = vi.spyOn(ctx.jev, 'ask').mockImplementationOnce((_request, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }) }))
  const competingAudits = await Promise.allSettled([ctx.jevRuns.control(directory, { source: 'devflow-audit', id: stalled.manifest.id, action: 'resume' }, agent), ctx.devflowJev.controlAudit(devflowRoot, stalled.manifest.id, 'resume', agent)])
  expect(competingAudits.filter(value => value.status === 'fulfilled')).toHaveLength(1)
  await expect.poll(async () => (await ctx.devflowJev.inspectAudit(devflowRoot, stalled.manifest.id)).state.status).toBe('running')
  await expect(ctx.jevRuns.control(directory, { source: 'devflow-audit', id: stalled.manifest.id, action: 'cancel' }, foreign)).rejects.toThrow()
  expect((await post(ctx.webServer.port, { method: 'audit-cancel', sessionId: agent.id, runId: stalled.manifest.id })).value).toMatchObject({ ok: true, data: { outcome: 'requested' } })
  await expect.poll(async () => (await ctx.devflowJev.inspectAudit(devflowRoot, stalled.manifest.id)).state.status).toBe('cancelled')
  ask.mockRestore()
  const resumedAudit = await ctx.jevRuns.control(directory, { source: 'devflow-audit', id: stalled.manifest.id, action: 'resume' }, agent)
  if (resumedAudit.jobId === undefined) throw new Error('resumed audit job missing')
  await expect(ctx.jobs.wait(JobId(resumedAudit.jobId), 2000, agent)).resolves.toMatchObject({ status: 'completed' })
  const originalDevflowPlugin = [...ctx.loader.entries()].find(entry => entry.options.name === '@zhchxiao123/dsh-devflow-jev')
  if (!originalDevflowPlugin?.fiber) throw new Error('Devflow plugin missing')
  await originalDevflowPlugin.fiber.dispose()
  expect(ctx.tools.get('devflow_assess')).toBeUndefined()
  await expect(ctx.jevRuns.list(directory, { source: 'devflow-audit' })).rejects.toThrow('unavailable')
  await expect(ctx.jevRuns.list(directory, { source: 'devflow-assessment' })).rejects.toThrow('unavailable')
  await expect(ctx.jevRuns.list(directory, { source: 'devflow-assistance' })).rejects.toThrow('unavailable')
  expect(ctx.tools.get('jev_list')).toBeDefined()
  const remounted = ctx.plugin(DevflowJevPlugin); await remounted.await()
  expect(await ctx.jevRuns.list(directory, { source: 'devflow-assistance' })).toEqual([{ source: 'devflow-assistance', id: assistanceRecord.id, record: assistanceRecord }])
  const genericPlugin = [...ctx.loader.entries()].find(entry => entry.options.name === '@zhchxiao123/dsh-jev/runs-plugin')
  if (!genericPlugin?.fiber) throw new Error('generic plugin missing')
  await genericPlugin.fiber.dispose()
  expect(ctx.tools.get('jev_run')).toBeUndefined()
  expect((await post(ctx.webServer.port, { method: 'context', sessionId: agent.id })).value).toMatchObject({ ok: true, data: { genericRunsAvailable: false } })
  expect((await post(ctx.webServer.port, { method: 'run-list', sessionId: agent.id })).value).toEqual({ ok: false, error: 'JEV_RUNS_UNAVAILABLE' })
  await remounted.dispose()
  expect(ctx.tools.get('devflow_assess')).toBeUndefined(); expect((await post(ctx.webServer.port, { method: 'audit-list', sessionId: agent.id })).status).toBe(404)
})
