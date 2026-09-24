// The per-check deadline bounds a hanging judgement to one failed check
// instead of one parked run: the run finishes as completed-with-errors in
// bounded time, while caller cancellation through the run signal keeps its
// meaning, with or without a deadline configured.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import JevRuntime, { FileJevRunStore, JevError, JevRunEngine } from '@zhchxiao123/dsh-jev'
import type { JevRequest, JevResponse, JevRunDefinition } from '@zhchxiao123/dsh-jev'
import { GenericJevRuns } from '@zhchxiao123/dsh-jev/runs-plugin'
import { scoreAnswer } from './memory.ts'

const request: JevRequest = { state: { evidence: 'x' }, questions: { risk: { type: 'score', instructions: 'risk', criteria: ['low', 'high'] } } }
const definition: JevRunDefinition = { id: 'run-1', scope: { kind: 'repository', id: '/tmp/example', title: 'Example' }, template: { id: 'repository-health', version: '1' }, createdAt: '2026-09-22T00:00:00.000Z', checkTimeoutMs: 50, checks: [
  { id: 'a', subject: { kind: 'file', id: 'a.ts', title: 'a.ts' }, evidenceDigest: 'one', request },
  { id: 'b', subject: { kind: 'file', id: 'b.ts', title: 'b.ts' }, evidenceDigest: 'two', request },
] }

/** Hangs on the first check until its signal aborts, the way the SDK's transport behaves. */
class HangingJev extends JevRuntime {
  protected override perform(perRequest: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    if (JSON.stringify(perRequest) === JSON.stringify(definition.checks[1]?.request) && this.answered) {
      return Promise.resolve({ answers: { risk: scoreAnswer(1) } })
    }
    this.answered = true
    return new Promise((_resolve, reject) => {
      const abort = () => { reject(new JevError('dsh-jev: the request was withdrawn', 'JEV_ABORTED')) }
      if (signal?.aborted === true) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private answered = false
}

describe('per-check deadline', () => {
  it('records a hanging check as JEV_TIMEOUT and finishes the run in bounded time', async () => {
    const engine = new JevRunEngine(new HangingJev(new Context()))
    const state = await engine.run(definition)
    expect(state).toMatchObject({ status: 'completed-with-errors', completed: 2, failed: 1 })
    expect(state.results[0]).toMatchObject({ checkId: 'a', status: 'failed', error: { code: 'JEV_TIMEOUT', message: 'the check deadline of 50ms elapsed' } })
    expect(state.results[1]).toMatchObject({ checkId: 'b', status: 'completed' })
  })

  it('keeps caller cancellation meaning cancel, deadline configured or not', async () => {
    const controller = new AbortController()
    const engine = new JevRunEngine(new HangingJev(new Context()))
    // The validate hook aborts between the loop's own check and the ask, so
    // the pre-aborted path through the deadline wrapper is what runs.
    const hooks = { validate: () => { controller.abort() } }
    const state = await engine.run({ ...definition, checkTimeoutMs: 5000 }, undefined, hooks, controller.signal)
    expect(state).toMatchObject({ status: 'cancelled', completed: 0 })
  })

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('rejects checkTimeoutMs %d before asking anything', async (value) => {
    const engine = new JevRunEngine(new HangingJev(new Context()))
    await expect(engine.run({ ...definition, checkTimeoutMs: value })).rejects.toThrow('checkTimeoutMs must be a positive finite number')
  })
})

describe('durable definitions', () => {
  let root: string | undefined
  afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })

  it('persists the deadline with the definition and rejects a malformed one at the file boundary', async () => {
    root = await mkdtemp(join(tmpdir(), 'jev-run-deadline-'))
    const store = new FileJevRunStore()
    await store.create(root, definition)
    expect((await store.read(root, definition.id)).definition.checkTimeoutMs).toBe(50)
    await expect(store.create(root, { ...definition, id: 'run-2', checkTimeoutMs: '50' } as unknown as JevRunDefinition))
      .rejects.toThrow('malformed run definition')
  })
})

describe('generic runs configuration', () => {
  it('rejects a non-positive deadline at load', () => {
    const ctx = new Context()
    expect(() => new GenericJevRuns(ctx, { checkTimeoutMs: 0 })).toThrow('checkTimeoutMs must be a positive finite number')
  })
})
