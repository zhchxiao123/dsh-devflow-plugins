// The one test that talks to the real service. It is `.e2e.ts` rather than
// `.spec.ts` so `vitest run` never collects it: the suite must stay runnable
// with no network and no key.
//
//   TYPESAFE_API_KEY=… pnpm exec vitest run \
//     packages/jev-typesafe/tests/typesafe.e2e.ts
//
// Run it when the fixtures under `tests/fixtures/` need replacing with real
// captures — see that directory's README for why they are not captures yet.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import TypeSafeJev from '@zhchxiao123/dsh-jev-typesafe'
import type { Question } from '@zhchxiao123/dsh-jev'

const KEY = process.env.TYPESAFE_API_KEY

/** Reads the key from the environment, which is what an e2e run has. */
class EnvCredentials extends CredentialProvider {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(
      KEY === undefined ? undefined : { ref, value: KEY, source: 'env' } as ResolvedCredential,
    )
  }

  override describe(): Promise<never> { return Promise.reject(new Error('unused')) }
  override set(): Promise<void> { return Promise.reject(new Error('unused')) }
  override unset(): Promise<void> { return Promise.reject(new Error('unused')) }
  override readRecord(): Promise<never> { return Promise.reject(new Error('unused')) }
  override describeRecord(): Promise<never> { return Promise.reject(new Error('unused')) }
  override listRecords(): Promise<never> { return Promise.reject(new Error('unused')) }
  override modifyRecord(): Promise<never> { return Promise.reject(new Error('unused')) }
  override deleteRecord(): Promise<void> { return Promise.reject(new Error('unused')) }
}

const SCORE: Question = {
  type: 'score',
  instructions: 'How urgent is this message?',
  criteria: ['Not urgent at all.', 'Somewhat time-sensitive.', 'Needs attention today.'],
}
const CHOICE: Question = {
  type: 'choice',
  instructions: 'Which team should handle this?',
  criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages', sales: null },
}
const NOUL: Question = { type: 'noul', instructions: 'Does this message express frustration?' }

describe.skipIf(KEY === undefined)('TypeSafeJev against the live service', () => {
  it('answers one question of each type', async () => {
    const ctx = new Context()
    await ctx.plugin(EnvCredentials)
    await ctx.plugin(TypeSafeJev, { apiKeyRef: 'TYPESAFE_API_KEY' })
    const response = await ctx.jev.ask({
      state: 'My payouts have been failing for three days and nobody has replied.',
      questions: { urgency: SCORE, team: CHOICE, frustrated: NOUL },
    })
    expect(response.answers.urgency).toMatchObject({ type: 'score' })
    expect(response.answers.team).toMatchObject({ type: 'choice' })
    expect(response.answers.frustrated).toMatchObject({ type: 'noul' })
    // The model that answered, for the fixture provenance table.
    expect(response.model).toBeTypeOf('string')
  })
})
