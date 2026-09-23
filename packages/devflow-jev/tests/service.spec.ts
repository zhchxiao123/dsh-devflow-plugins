import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import { JevError, JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import { DevflowJev } from '@zhchxiao123/dsh-devflow-jev'
import { assessmentRequest } from '@zhchxiao123/dsh-devflow-jev'
import { collectEvidence } from '../src/evidence.ts'
class ScriptedJev extends JevRuntime {
  fail = false
  protected perform(_request: JevRequest): Promise<JevResponse> {
    if (this.fail) throw new JevError('offline', 'JEV_UNAVAILABLE')
    return Promise.resolve({ model: 'test-jev', answers: {
      codeSolvable: { type: 'noul', noul: 0.96 }, informationSufficient: { type: 'noul', noul: 0.9 },
      value: { type: 'score', score: 3.2, probabilities: [0, 0, 0.1, 0.7, 0.2], confidence: 0.9 },
      risk: { type: 'score', score: 1.2, probabilities: [0.1, 0.7, 0.2, 0, 0], confidence: 0.9 },
      scopeClarity: { type: 'score', score: 3.1, probabilities: [0, 0, 0.1, 0.7, 0.2], confidence: 0.9 },
      recommendedAction: { type: 'choice', choice: 'create', probabilities: { create: 0.9, investigate: 0.05, ask: 0.03, reject: 0.02 }, confidence: 0.9 },
      serviceClass: { type: 'choice', choice: 'standard', probabilities: { standard: 0.95, express: 0.04, emergency: 0.01 }, confidence: 0.94 },
    } })
  }
}
let ctx: Context | undefined; let base: string | undefined
async function boot(): Promise<{ ctx: Context; root: string; jev: ScriptedJev }> {
  base = await mkdtemp(join(tmpdir(), 'devflow-jev-')); const root = join(base, '.devflow'); ctx = new Context()
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  await ctx.plugin(ScriptedJev).await()
  await ctx.plugin(DevflowJev).await()
  return { ctx, root, jev: ctx.jev as ScriptedJev }
}
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
})
describe('DevflowJev', () => {
  it('stores a proposal and accepts it idempotently into one card', async () => {
    const { ctx, root } = await boot(); const evaluation = await ctx.devflowJev.assessRequest({ root, title: 'Fix login', body: 'Stop the login page from going blank.' })
    expect(evaluation).toMatchObject({ decision: 'propose', status: 'review', providerModel: 'test-jev' })
    const [first, second] = await Promise.all([ctx.devflowJev.accept(root, evaluation.id, { kind: 'human' }), ctx.devflowJev.accept(root, evaluation.id, { kind: 'human' })])
    expect(first.createdCardId).toBe(second.createdCardId); expect((await ctx.devflow.list(undefined, root))).toHaveLength(1)
    expect((await ctx.devflowJev.read(root, evaluation.id)).status).toBe('created')
  })
  it('records provider failure without creating a card', async () => {
    const { ctx, root, jev } = await boot(); jev.fail = true
    const evaluation = await ctx.devflowJev.assessRequest({ root, title: 'Unknown', body: 'Investigate it.' })
    expect(evaluation).toMatchObject({ decision: 'unavailable', status: 'unavailable', error: { code: 'JEV_UNAVAILABLE' } })
    expect(await ctx.devflow.list(undefined, root)).toEqual([]); expect(await ctx.devflowJev.list(root)).toHaveLength(1)
  })
  it('recovers a card committed before the evaluation state write', async () => {
    const { ctx, root } = await boot()
    const evaluation = await ctx.devflowJev.assessRequest({ root, title: 'Recover me', body: 'One card only.' })
    const created = await ctx.devflow.create(ctx.devflow.resolveCreate({
      root, title: 'Recover me',
      body: `One card only.\n\n## Judgement\n\nSource evaluation: ${evaluation.id}\n`,
      by: { kind: 'human' },
    }))
    if (!created.ok) throw new Error(created.message)
    const recovered = await ctx.devflowJev.accept(root, evaluation.id, { kind: 'human' })
    expect(recovered.createdCardId).toBe(created.card.id)
    expect(await ctx.devflow.list(undefined, root)).toHaveLength(1)
  })
  it('binds a card assessment to the observed stage revision', async () => {
    const { ctx, root } = await boot(); const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Existing', body: 'Acceptance.', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
    const evaluation = await ctx.devflowJev.assessCard({ root, cardId: created.card.id, assessmentKind: 'planning' })
    expect(evaluation.subject).toMatchObject({ kind: 'card', cardId: DevflowCardId(created.card.id), stage: 'draft', stageRevision: 1 })
    expect(evaluation.decision).toBe('continue')
  })
  it('uses distinct typed questions for each assessment kind', () => {
    const planning = assessmentRequest({ card: { title: 'Plan' } }, 'planning')
    const release = assessmentRequest({ card: { title: 'Release' } }, 'release-readiness')
    expect(planning.questions).toHaveProperty('acceptanceExecutable')
    expect(planning.questions).not.toHaveProperty('releaseDecision')
    expect(release.questions).toHaveProperty('releaseDecision')
    expect(release.questions).not.toHaveProperty('acceptanceExecutable')
  })
  it('runs and persists a stage-aware project audit without mutating cards', async () => {
    const { ctx, root } = await boot(); const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Audit me', body: 'Concrete requirement and acceptance.', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
    const attached = await ctx.devflow.attachArtifact({ id: created.card.id, kind: 'requirements-document', content: '# Requirement\nEvidence.', expectedRevision: created.card.stageRevision, by: { kind: 'human' } }); if (!attached.ok) throw new Error(attached.message)
    const prepared = await ctx.devflowJev.prepareAudit({ root, profile: 'delivery-health' })
    expect(prepared.manifest.checks.map(check => check.assessmentKind)).toEqual(['intake', 'planning', 'spec-delta'])
    await ctx.devflowJev.bindAuditJob(root, prepared.manifest.id, 'jev-audit-1')
    const completed = await ctx.devflowJev.runAudit(root, prepared.manifest.id)
    expect(completed.state).toMatchObject({ status: 'completed', completed: 3, failed: 0 })
    expect((await ctx.devflowJev.listAudits(root))[0]).toMatchObject({ manifest: { id: prepared.manifest.id }, state: { jobId: 'jev-audit-1' } })
    expect((await ctx.devflow.read(created.card.id, root)).stageRevision).toBe(attached.card.stageRevision)
  })
  it('persists cancellation and can resume unfinished checks', async () => {
    const { ctx, root } = await boot(); const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Resume me', body: 'Acceptance.', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
    const prepared = await ctx.devflowJev.prepareAudit({ root }); const controller = new AbortController(); controller.abort()
    const cancelled = await ctx.devflowJev.runAudit(root, prepared.manifest.id, controller.signal)
    expect(cancelled.state.status).toBe('cancelled')
    const resumed = await ctx.devflowJev.resumeAudit(root, prepared.manifest.id)
    expect(resumed.state).toMatchObject({ status: 'completed', completed: 3 })
  })
  it('marks completed checks stale when durable evidence changes before recovery', async () => {
    const { ctx, root } = await boot(); const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Changing evidence', body: 'Acceptance.', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
    const prepared = await ctx.devflowJev.prepareAudit({ root }); await ctx.devflowJev.runAudit(root, prepared.manifest.id)
    const attached = await ctx.devflow.attachArtifact({ id: created.card.id, kind: 'requirements-document', content: '# Changed', expectedRevision: created.card.stageRevision, by: { kind: 'human' } }); if (!attached.ok) throw new Error(attached.message)
    const statePath = join(root, 'judgements', 'audits', prepared.manifest.id, 'state.json'); const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>; await writeFile(statePath, JSON.stringify({ ...state, status: 'interrupted' }))
    const resumed = await ctx.devflowJev.resumeAudit(root, prepared.manifest.id)
    expect(resumed.state).toMatchObject({ status: 'completed-with-errors', failed: 3 })
    expect(resumed.state.results.every(result => result.status === 'stale')).toBe(true)
    await expect(ctx.devflowJev.inspectAudit(root, '../escape')).rejects.toThrow('invalid audit run id')
  })
  it('turns hostile, missing, oversized, and non-file artifact registrations into explicit gaps', async () => {
    const { ctx, root } = await boot(); const created = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Evidence boundary', body: 'Acceptance.', by: { kind: 'human' } })); if (!created.ok) throw new Error(created.message)
    const artifacts = join(root, 'tasks', created.card.id, 'artifacts'); await mkdir(join(artifacts, 'real'), { recursive: true }); await mkdir(join(artifacts, 'not-file')); await writeFile(join(artifacts, 'real', 'report.md'), 'safe'); await symlink('real', join(artifacts, 'link')); await writeFile(join(artifacts, 'large.md'), 'x'.repeat(17 * 1024))
    const artifactRecords = ['../secret.md', 'artifacts/.env', 'artifacts/missing.md', 'artifacts/large.md', 'artifacts/not-file', 'artifacts/link/report.md'].map((path, index) => ({ path, rev: index + 1, stage: 'draft' as const }))
    const card = { ...created.card, artifactRecords, artifacts: artifactRecords.map(record => record.path) }
    const evidence = await collectEvidence(root, card, [card], await ctx.devflow.history(created.card.id, root))
    expect(evidence.artifacts).toEqual([]); expect(evidence.gaps.map(gap => gap.kind)).toEqual(['unsafe', 'unsafe', 'missing', 'oversized', 'unreadable', 'unsafe'])
    expect(evidence.journal[0]).toHaveProperty('by')
  })
})
