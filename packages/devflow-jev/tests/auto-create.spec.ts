// The judged action decides creation: create and investigate become cards the
// moment they are judged, ask and reject never do, and floors only inform the
// record — nothing waits in a review queue.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { JevRuntime } from '@zhchxiao123/dsh-jev'
import type { Answer, JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import { DevflowJev, summarizeEvaluation } from '@zhchxiao123/dsh-devflow-jev'

class ActionJev extends JevRuntime {
  action = 'create'
  protected perform(_request: JevRequest): Promise<JevResponse> {
    const choice = (value: string): Answer => ({ type: 'choice', choice: value, probabilities: { [value]: 0.9 }, confidence: 0.9 })
    return Promise.resolve({ model: 'fixture', answers: {
      codeSolvable: { type: 'noul', noul: 0.9 }, informationSufficient: { type: 'noul', noul: 0.9 },
      // A middling value below the propose floor: floors inform, they do not gate.
      value: { type: 'score', score: 2.1, probabilities: [0, 0.1, 0.6, 0.3, 0], confidence: 0.68 },
      risk: { type: 'score', score: 2.8, probabilities: [0, 0, 0.2, 0.8, 0], confidence: 0.86 },
      scopeClarity: { type: 'score', score: 3, probabilities: [0, 0, 0.2, 0.5, 0.3], confidence: 0.57 },
      recommendedAction: choice(this.action), serviceClass: choice('standard'),
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

async function boot(): Promise<{ ctx: Context; root: string; jev: ActionJev }> {
  base = await mkdtemp(join(tmpdir(), 'devflow-jev-auto-'))
  const root = join(base, '.devflow')
  ctx = new Context()
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  await ctx.plugin(ActionJev).await()
  await ctx.plugin(DevflowJev).await()
  return { ctx, root, jev: ctx.jev as ActionJev }
}

it.each(['create', 'investigate'] as const)('creates the card as soon as the judged action is %s', async (action) => {
  const { ctx, root, jev } = await boot()
  jev.action = action
  const record = await ctx.devflowJev.assessRequest({ root, title: 'Ship it', body: 'Concrete outcome.' })
  expect(record.status).toBe('created')
  expect(record.decision).toBe('manual-review')
  const cards = await ctx.devflow.list(undefined, root)
  expect(cards).toHaveLength(1)
  expect(cards[0]?.title).toBe('Ship it')
})

it.each(['ask', 'reject'] as const)('creates nothing when the judged action is %s', async (action) => {
  const { ctx, root, jev } = await boot()
  jev.action = action
  const record = await ctx.devflowJev.assessRequest({ root, title: 'Hold it', body: 'Unclear outcome.' })
  expect(record.status).toBe('review')
  expect(await ctx.devflow.list(undefined, root)).toEqual([])
})

it('carries the raw judgement into the summary the list shows', async () => {
  const { ctx, root } = await boot()
  const record = await ctx.devflowJev.assessRequest({ root, title: 'Ship it', body: 'Concrete outcome.' })
  expect(summarizeEvaluation(record).keyAnswers).toEqual({ value: 2.1, risk: 2.8, action: 'create', actionProbability: 0.9 })
  // A distribution that omits its chosen option reads as probability zero, not an invented number.
  const sparse = { ...record, answers: { recommendedAction: { type: 'choice' as const, choice: 'create', probabilities: {}, confidence: 0.2 } } }
  expect(summarizeEvaluation(sparse).keyAnswers).toEqual({ action: 'create', actionProbability: 0 })
})
