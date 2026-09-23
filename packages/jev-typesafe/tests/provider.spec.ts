// The provider end to end, with the credential seam and the transport replaced.
// What these prove is that the seam's contract survives a real SDK round trip:
// the key is re-read every call, each transport failure lands on the code an
// operator would act on, and an answer that will not decode leaves its key out
// instead of arriving as a number nobody measured.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { JevRequest, Question } from '@zhchxiao123/dsh-jev'
import { MemoryCredentials, RealClientJev, ScriptedJev, json } from './doubles.ts'

const SCORE: Question = {
  type: 'score',
  instructions: 'How risky is this change?',
  criteria: ['Trivial', 'Routine', 'Notable'],
}
const CHOICE: Question = {
  type: 'choice',
  instructions: 'Which team should handle this?',
  criteria: { billing: 'Payments', technical: 'Bugs', sales: null },
}
const NOUL: Question = { type: 'noul', instructions: 'Does this convey urgency?' }

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
}

async function mount(): Promise<{ ctx: Context; jev: ScriptedJev; credentials: MemoryCredentials }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(ScriptedJev, { apiKeyRef: 'TYPESAFE_API_KEY' })
  return { ctx, jev: ctx.jev as ScriptedJev, credentials: ctx.credentials as MemoryCredentials }
}

function ask(questions: Record<string, Question>): JevRequest {
  return { state: { note: 'evidence' }, questions }
}

describe('TypeSafeJev', () => {
  it('provides ctx.jev without the definition package being mounted separately', async () => {
    const { jev } = await mount()
    expect(typeof jev.ask).toBe('function')
  })

  it('sends the state, the questions, and the configured model', async () => {
    const { jev } = await mount()
    jev.setScript(() => json(fixture('score-choice-noul')))
    await jev.ask(ask({ risk: SCORE, team: CHOICE, urgent: NOUL }))
    expect(jev.sent).toHaveLength(1)
    expect(jev.sent[0]).toMatchObject({
      model: 'jev-1.13.0',
      state: { note: 'evidence' },
      questions: { risk: { type: 'score' }, team: { type: 'choice' }, urgent: { type: 'noul' } },
    })
  })

  it('decodes one answer of each type, indexing score probabilities by level', async () => {
    const { jev } = await mount()
    jev.setScript(() => json(fixture('score-choice-noul')))
    const response = await jev.ask(ask({ risk: SCORE, team: CHOICE, urgent: NOUL }))
    expect(response.answers.risk).toEqual({
      type: 'score',
      score: 1.4,
      confidence: 0.82,
      probabilities: [0.1, 0.4, 0.5],
    })
    expect(response.answers.team).toEqual({
      type: 'choice',
      choice: 'billing',
      confidence: 0.91,
      probabilities: { billing: 0.91, technical: 0.07, sales: 0.02 },
    })
    expect(response.answers.urgent).toEqual({ type: 'noul', noul: 0.73 })
    expect(response.usage).toEqual({ inputTokens: 2481, outputTokens: 0 })
    expect(response.model).toBe('jev-1.13.0')
  })

  it('leaves out a question the service skipped and one it answered unreadably', async () => {
    const { jev } = await mount()
    jev.setScript(() => json(fixture('partial')))
    const response = await jev.ask(ask({ answered: SCORE, unreadable: SCORE, skipped: SCORE }))
    expect(Object.keys(response.answers)).toEqual(['answered'])
    // A level the model gave no weight is absent on the wire; reading it as
    // zero is what an omitted entry in a distribution means.
    expect(response.answers.answered).toMatchObject({ probabilities: [0.8, 0, 0] })
  })
})

describe('TypeSafeJev credentials', () => {
  it('resolves credentials from the provider context when a generic consumer calls ctx.jev', async () => {
    const { ctx, jev } = await mount()
    jev.setScript(() => json(fixture('score-choice-noul')))
    let response: Promise<unknown> | undefined

    class GenericJevConsumer {
      static inject = ['jev']

      constructor(consumerCtx: Context) {
        response = consumerCtx.jev.ask(ask({ risk: SCORE }))
      }
    }

    await ctx.plugin(GenericJevConsumer)
    expect(response).toBeDefined()
    await expect(response).resolves.toMatchObject({ answers: { risk: { type: 'score' } } })
  })

  it('re-resolves the reference on every call, so a rotation takes effect without a restart', async () => {
    const { jev, credentials } = await mount()
    jev.setScript(() => json(fixture('score-choice-noul')))
    await jev.ask(ask({ risk: SCORE }))
    credentials.value = 'sk-rotated'
    await jev.ask(ask({ risk: SCORE }))
    expect(credentials.reads).toBe(2)
  })

  it('raises JEV_CREDENTIAL_MISSING when the reference resolves to nothing', async () => {
    const { jev, credentials } = await mount()
    credentials.value = undefined
    await expect(jev.ask(ask({ risk: SCORE })))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_CREDENTIAL_MISSING' }))
  })

  it('raises JEV_CREDENTIAL_MISSING when the lookup itself fails', async () => {
    const { jev, credentials } = await mount()
    credentials.failure = new Error('store unavailable')
    await expect(jev.ask(ask({ risk: SCORE })))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_CREDENTIAL_MISSING' }))
  })
})

describe('TypeSafeJev failure classification', () => {
  it('maps a rate refusal to JEV_RATE_LIMITED', async () => {
    const { jev } = await mount()
    jev.setScript(() => json({ error: 'slow down' }, 429))
    await expect(jev.ask(ask({ risk: SCORE })))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_RATE_LIMITED' }))
  })

  it.each([401, 400, 500])('maps HTTP %i to JEV_HTTP_ERROR', async (status) => {
    const { jev } = await mount()
    jev.setScript(() => json({ error: 'nope' }, status))
    await expect(jev.ask(ask({ risk: SCORE })))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_HTTP_ERROR' }))
  })

  it('maps a delivery failure to JEV_UNAVAILABLE', async () => {
    const { jev } = await mount()
    jev.setScript(() => { throw new TypeError('fetch failed') })
    await expect(jev.ask(ask({ risk: SCORE })))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_UNAVAILABLE' }))
  })

  it('maps a withdrawn request to JEV_ABORTED', async () => {
    const { jev } = await mount()
    const controller = new AbortController()
    jev.setScript(async () => {
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 50))
      return json(fixture('score-choice-noul'))
    })
    await expect(jev.ask(ask({ risk: SCORE }), controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_ABORTED' }))
  })

  it('omits usage and model when the response carries neither', async () => {
    const { jev } = await mount()
    jev.setScript(() => json({ answers: { risk: { type: 'score', score: 0, confidence: 1, probabilities: {} } } }))
    const response = await jev.ask(ask({ risk: SCORE }))
    expect('usage' in response).toBe(false)
    expect('model' in response).toBe(false)
    expect(response.answers.risk).toBeDefined()
  })

  it('raises JEV_BAD_RESPONSE for a success that carries no answers', async () => {
    const { jev } = await mount()
    jev.setScript(() => json({ model: 'jev-1.13.0', usage: {} }))
    await expect(jev.ask(ask({ risk: SCORE })))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_BAD_RESPONSE' }))
  })
})

describe('TypeSafeJev client construction', () => {
  it('builds a client per call from the configured endpoint and model', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(RealClientJev, { apiKeyRef: 'TYPESAFE_API_KEY', baseURL: 'https://api.example.test' })
    const provider = ctx.jev as RealClientJev
    const first = provider.build('sk-one')
    const second = provider.build('sk-two')
    // Two calls, two clients: the key is resolved per call and the SDK takes it
    // at construction, so a retained client would pin whichever key was current
    // when the plugin loaded.
    expect(first).not.toBe(second)
  })

  it('raises JEV_BAD_RESPONSE when the body is not an object at all', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(ScriptedJev, { apiKeyRef: 'TYPESAFE_API_KEY' })
    const provider = ctx.jev as ScriptedJev
    provider.setScript(() => json(null))
    await expect(provider.ask({ state: 's', questions: { risk: SCORE } }))
      .rejects.toThrow(expect.objectContaining({ code: 'JEV_BAD_RESPONSE' }))
  })
})

describe('TypeSafeJev disposal', () => {
  it('releases ctx.jev with the fiber that provided it', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    const fiber = await ctx.plugin(ScriptedJev, { apiKeyRef: 'TYPESAFE_API_KEY' })
    expect(ctx.get('jev')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('jev')).toBeUndefined()
  })
})

describe('local configuration status', () => {
  it('tracks credential rotation and failures without sending a request or leaking resolver errors', async () => {
    const { ctx, jev, credentials } = await mount()
    const statuses: string[] = []
    for (const value of [undefined, '', '   ', 'sk-private-configured', undefined, 'sk-rotated']) {
      credentials.value = value
      statuses.push(await jev.configurationStatus())
    }
    credentials.failure = new Error('sensitive store diagnostic sk-private-configured')
    statuses.push(await jev.configurationStatus())
    expect(statuses).toEqual(['unconfigured', 'unconfigured', 'unconfigured', 'configured', 'unconfigured', 'configured', 'unconfigured'])
    expect(jev.sent).toEqual([])
    let consumerStatus: Promise<string> | undefined
    credentials.failure = undefined
    await ctx.plugin({ inject: ['jev'], apply(child: Context) { consumerStatus = child.jev.configurationStatus() } })
    await expect(consumerStatus).resolves.toBe('configured')
    expect(credentials.reads).toBe(8)
    await ctx.fiber.dispose()
  })
})
