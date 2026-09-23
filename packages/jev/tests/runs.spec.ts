/* oxlint-disable @stylistic/max-len */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { JevRunEngine } from '@zhchxiao123/dsh-jev'
import type { JevRunDefinition } from '@zhchxiao123/dsh-jev'
import { MemoryJev, scoreAnswer } from './memory.ts'

const request = { state: { evidence: 'x' }, questions: { risk: { type: 'score' as const, instructions: 'risk', criteria: ['low', 'high'] as const } } }
const definition: JevRunDefinition = { id: 'run-1', scope: { kind: 'repository', id: '/tmp/example', title: 'Example' }, template: { id: 'repository-health', version: '1' }, createdAt: '2026-09-22T00:00:00.000Z', checks: [
  { id: 'a', subject: { kind: 'file', id: 'a.ts', title: 'a.ts' }, evidenceDigest: 'one', request },
  { id: 'b', subject: { kind: 'file', id: 'b.ts', title: 'b.ts' }, evidenceDigest: 'two', request },
] }

describe('JevRunEngine', () => {
  it('executes domain-neutral checks and reports durable progress', async () => {
    const ctx = new Context(); const provider = new MemoryJev(ctx, { answers: { risk: scoreAnswer(1) } }); const engine = new JevRunEngine(provider); const seen: number[] = []
    const state = await engine.run(definition, undefined, { onState: (value) => { seen.push(value.completed) } })
    expect(state).toMatchObject({ status: 'completed', total: 2, completed: 2, failed: 0 })
    expect(state.results.map(result => result.subject.kind)).toEqual(['file', 'file'])
    expect(seen).toEqual([0, 1, 2, 2])
  })

  it('cancels and resumes only unfinished checks', async () => {
    const ctx = new Context(); const controller = new AbortController(); let calls = 0
    const provider = new MemoryJev(ctx, () => { calls += 1; if (calls === 1) controller.abort(); return { answers: { risk: scoreAnswer(1) } } })
    const engine = new JevRunEngine(provider); const cancelled = await engine.run(definition, undefined, {}, controller.signal)
    expect(cancelled).toMatchObject({ status: 'cancelled', completed: 1 })
    const resumed = await engine.run(definition, cancelled)
    expect(resumed).toMatchObject({ status: 'completed', completed: 2 }); expect(calls).toBe(2)
  })

  it('marks a persisted non-terminal run without an active executor as interrupted', () => {
    const engine = new JevRunEngine(new MemoryJev(new Context()))
    expect(engine.recover({ runId: 'x', status: 'planned', total: 2, completed: 0, failed: 0, results: [], createdAt: 'now' }).status).toBe('interrupted')
    expect(engine.recover({ runId: 'x', status: 'running', total: 2, completed: 1, failed: 0, results: [], createdAt: 'now' }).status).toBe('interrupted')
    expect(engine.recover({ runId: 'x', status: 'planned', total: 2, completed: 0, failed: 0, results: [], createdAt: 'now', jobId: 'stale-job' }).status).toBe('interrupted')
  })

  it('retains successful checks and retries only partial failures', async () => {
    let calls = 0; const provider = new MemoryJev(new Context(), () => { calls += 1; if (calls === 2) throw new Error('temporary'); return { answers: { risk: scoreAnswer(1) } } }); const engine = new JevRunEngine(provider)
    const partial = await engine.run(definition); expect(partial).toMatchObject({ status: 'completed-with-errors', completed: 2, failed: 1 })
    const completed = await engine.run(definition, partial); expect(completed).toMatchObject({ status: 'completed', completed: 2, failed: 0 }); expect(calls).toBe(3)
  })
})
