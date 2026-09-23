/* oxlint-disable @stylistic/max-len */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { afterEach, expect, it } from 'vitest'
import { MemoryJev } from '../../jev/tests/memory.ts'
import { GenericJevRuns } from '@zhchxiao123/dsh-jev/runs-plugin'
import { emptyInbox } from '../../../tests/agent-double.ts'
import { DevflowJev } from '../src/service.ts'
import { DevflowAssistance } from '../src/assistance.ts'
import { assistanceConfig } from '../src/assistance-config.ts'
import { AssistanceStore } from '../src/assistance-store.ts'
import { registerSources } from '../src/sources.ts'

let context: Context | undefined; let directory: string | undefined
afterEach(async () => { await context?.fiber.dispose(); if (directory !== undefined) await rm(directory, { recursive: true, force: true }); context = undefined; directory = undefined })
it('uses optional source adapters through the real run registry and removes them with their scope', async () => {
  const ctx = new Context(); context = ctx; registerSources(ctx)
  directory = await mkdtemp(join(tmpdir(), 'jev-sources-')); const project = directory; const root = join(project, '.devflow')
  await ctx.plugin(SystemPrompt); await ctx.plugin(Sessions); await ctx.plugin(AgentRegistry); await ctx.plugin(Tools); await ctx.plugin(Jobs)
  await ctx.plugin(FilesystemDevflowStore, { root }); await ctx.plugin(MemoryJev); await ctx.plugin(DevflowJev); await ctx.plugin(GenericJevRuns)
  ctx.effect(() => ctx.jobs.attachController('jev-source-test'))
  const fiber = ctx.plugin({ inject: ['devflowJev', 'jevRuns'], apply(child: Context) { registerSources(child) } }); await fiber
  const session = ctx.sessions.create(SessionId('source-owner'), { meta: { cwd: project } })
  const agent: Agent = { id: session.id, session, ctx, options: {}, inbox: emptyInbox(), status: 'idle', followup() {}, steer() {}, inject() {}, send() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(agent)
  const evaluation = await ctx.devflowJev.assessRequest({ root, title: 'Request', body: 'Acceptance.' })
  expect(await ctx.jevRuns.list(project, { source: 'devflow-assessment' })).toMatchObject([{ id: evaluation.id }])
  expect(await ctx.jevRuns.list(project, { source: 'devflow-assessment', id: evaluation.id })).toMatchObject([{ record: evaluation }])
  const started: unknown = await ctx.jevRuns.run(project, { source: 'devflow-audit', profile: 'full' }, agent)
  if (typeof started !== 'object' || started === null || !('jobId' in started) || typeof started.jobId !== 'string') throw new Error('missing job')
  await ctx.jobs.wait(JobId(started.jobId), 2000, agent)
  const audits = await ctx.jevRuns.list(project, { source: 'devflow-audit' }); const audit = audits[0]
  if (audit === undefined) throw new Error('missing audit')
  expect(await ctx.jevRuns.list(project, { source: 'devflow-audit', id: audit.id })).toMatchObject([{ id: audit.id }])
  expect(await ctx.jevRuns.control(project, { source: 'devflow-audit', id: audit.id, action: 'cancel' }, agent)).toMatchObject({ outcome: 'already-finished' })
  await ctx.plugin(DevflowAssistance, assistanceConfig({ mode: 'off' }))
  const record = { id: randomUUID(), workspace: project, sessionId: agent.id, turn: 1, event: 'planning' as const, mode: 'observe' as const, evidenceDigest: 'digest', policyVersion: '2', action: 'continue' as const, reason: 'Continue.', evidenceRefs: [], gaps: [], confidence: 1, status: 'observed' as const, outcome: 'unknown' as const, elapsedMs: 1, createdAt: 'now', updatedAt: 'now' }
  await new AssistanceStore().write(project, record)
  expect(await ctx.jevRuns.list(project, { source: 'devflow-assistance' })).toMatchObject([{ id: record.id }])
  expect(await ctx.jevRuns.list(project, { source: 'devflow-assistance', id: record.id })).toMatchObject([{ record }])
  await fiber.dispose()
  await expect(ctx.jevRuns.list(project, { source: 'devflow-audit' })).rejects.toThrow('unavailable')
  await expect(ctx.jevRuns.list(project, { source: 'devflow-assistance' })).rejects.toThrow('unavailable')
})
