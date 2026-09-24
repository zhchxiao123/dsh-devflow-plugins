// Card outcomes are labels nobody has to click: finishing a card accepts the
// open advice on it, a human verdict given first is never overwritten, and an
// abandoned card's advice stays untouched at runtime — the calibration
// exporter derives that side from the journal.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor } from '@zhchxiao123/dsh-devflow'
import { JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import { DevflowJev } from '@zhchxiao123/dsh-devflow-jev'

const HUMAN: DevActor = { kind: 'human', name: 'byclaw' }
const EDGES = ['designing', 'ready', 'developing', 'reviewing', 'testing', 'done'] as const

class PlanningJev extends JevRuntime {
  protected perform(_request: JevRequest): Promise<JevResponse> {
    return Promise.resolve({ model: 'fixture', answers: {
      acceptanceExecutable: { type: 'noul', noul: 0.9 },
      dependencyClarity: { type: 'score', score: 3, probabilities: [0, 0, 0, 1, 0], confidence: 0.9 },
    } })
  }
}

let ctx: Context | undefined
let base: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
})

it('settles card advice from the card outcome, keeps human verdicts, and leaves proposals alone', async () => {
  base = await mkdtemp(join(tmpdir(), 'devflow-jev-settle-'))
  const root = join(base, '.devflow')
  ctx = new Context()
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  await ctx.plugin(PlanningJev).await()
  await ctx.plugin(DevflowJev).await()

  // A card can finish before any judgement exists; settling then has nothing to read.
  const early = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Early finish', body: 'No advice yet.', by: HUMAN }))
  if (!early.ok) throw new Error('fixture card did not create')
  for (const [step, to] of EDGES.entries()) {
    await ctx.devflow.transition(ctx.devflow.resolve({ id: DevflowCardId(early.card.id), to, expectedRevision: step + 1, by: HUMAN }))
  }

  const finished = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Finish me', body: 'Work to complete.', by: HUMAN }))
  const dropped = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Drop me', body: 'Work to abandon.', by: HUMAN }))
  if (!finished.ok || !dropped.ok) throw new Error('fixture cards did not create')

  const openAdvice = await ctx.devflowJev.assessCard({ root, cardId: finished.card.id, assessmentKind: 'planning' })
  const humanRejected = await ctx.devflowJev.assessCard({ root, cardId: finished.card.id, assessmentKind: 'planning' })
  const abandonedAdvice = await ctx.devflowJev.assessCard({ root, cardId: dropped.card.id, assessmentKind: 'planning' })
  for (const record of [openAdvice, humanRejected, abandonedAdvice]) expect(record.status).toBe('review')
  await ctx.devflowJev.decideJudgement(root, humanRejected.id, 'reject', HUMAN)
  const rejectedAt = (await ctx.devflowJev.read(root, humanRejected.id)).decidedAt
  // A torn record is the panel's problem to report; settling walks past it.
  await mkdir(join(root, 'judgements', 'evaluations'), { recursive: true })
  await writeFile(join(root, 'judgements', 'evaluations', 'deadbeef.json'), '{ torn')

  for (const [step, to] of EDGES.entries()) {
    const spec = ctx.devflow.resolve({ id: DevflowCardId(finished.card.id), to, expectedRevision: step + 1, by: HUMAN })
    expect(await ctx.devflow.transition(spec)).toMatchObject({ ok: true })
  }
  await vi.waitFor(async () => {
    expect((await ctx!.devflowJev.read(root, openAdvice.id)).status).toBe('accepted')
  })
  // The human verdict predates the outcome and stands untouched.
  expect(await ctx.devflowJev.read(root, humanRejected.id)).toMatchObject({ status: 'rejected', decidedAt: rejectedAt })

  const abandoned = await ctx.devflow.abandon({ id: DevflowCardId(dropped.card.id), expectedRevision: 1, by: HUMAN, reason: 'not needed', root })
  expect(abandoned).toMatchObject({ ok: true })
  // No event carries abandonment; the runtime leaves the advice as it was.
  expect((await ctx.devflowJev.read(root, abandonedAdvice.id)).status).toBe('review')

  // A settling write that fails must never disturb the transition that triggered it.
  const locked = await ctx.devflow.create(ctx.devflow.resolveCreate({ root, title: 'Locked out', body: 'Unwritable advice.', by: HUMAN }))
  if (!locked.ok) throw new Error('fixture card did not create')
  const lockedAdvice = await ctx.devflowJev.assessCard({ root, cardId: locked.card.id, assessmentKind: 'planning' })
  const evaluations = join(root, 'judgements', 'evaluations')
  await chmod(evaluations, 0o500)
  try {
    for (const [step, to] of EDGES.entries()) {
      const spec = ctx.devflow.resolve({ id: DevflowCardId(locked.card.id), to, expectedRevision: step + 1, by: HUMAN })
      expect(await ctx.devflow.transition(spec)).toMatchObject({ ok: true })
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  } finally {
    await chmod(evaluations, 0o700)
  }
  expect((await ctx.devflowJev.read(root, lockedAdvice.id)).status).toBe('review')
})
