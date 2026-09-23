import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import { JevError, JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import { DevflowJev } from '@zhchxiao123/dsh-devflow-jev'
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
})
