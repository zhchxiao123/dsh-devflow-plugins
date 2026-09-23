/* oxlint-disable @stylistic/max-len */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { DurableJevRuns, FileJevRunStore, JevRunEngine, initialJevRunState } from '@zhchxiao123/dsh-jev'
import type { JevRunDefinition } from '@zhchxiao123/dsh-jev'
import { MemoryJev, scoreAnswer } from './memory.ts'

const directories: string[] = []
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'jev-recovery-')); directories.push(root); return root }
const definition: JevRunDefinition = { id: 'run', scope: { kind: 'repository', id: 'repo', title: 'Repo' }, template: { id: 'test', version: '1' }, createdAt: '2026-09-01', checks: [{ id: 'check', subject: { kind: 'file', id: 'a.ts', title: 'A' }, evidenceDigest: 'first', request: { state: {}, questions: { risk: { type: 'score', instructions: 'Risk', criteria: ['low', 'high'] } } } }] }

it('validates persisted definitions, state, and job bindings before recovery', async () => {
  const root = await directory(); const store = new FileJevRunStore(); await store.create(root, definition)
  const state = initialJevRunState(definition)
  for (const bad of [null, [], { ...definition, id: 'wrong' }, { ...definition, createdAt: 1 }, { ...definition, checks: {} },
    ...['kind', 'id', 'title'].map(key => ({ ...definition, scope: { ...definition.scope, [key]: 1 } })),
    ...['id', 'version'].map(key => ({ ...definition, template: { ...definition.template, [key]: 1 } })),
    ...[null, { ...definition.checks[0], subject: null }, { ...definition.checks[0], request: null },
      ...['id', 'evidenceDigest'].map(key => ({ ...definition.checks[0], [key]: 1 })),
      ...['kind', 'id', 'title'].map(key => ({ ...definition.checks[0], subject: { ...definition.checks[0]?.subject, [key]: 1 } })),
      { ...definition.checks[0], request: { questions: {} } }, ...[null, 1, []].map(questions => ({ ...definition.checks[0], request: { state: {}, questions } }))].map(check => ({ ...definition, checks: [check] }))]) {
    await writeFile(join(root, 'runs/run/definition.json'), JSON.stringify(bad)); await expect(store.read(root, 'run')).rejects.toThrow('malformed')
  }
  await writeFile(join(root, 'runs/run/definition.json'), JSON.stringify(definition))
  for (const bad of [null, ...['runId', 'status', 'total', 'completed', 'failed', 'results', 'createdAt'].map(key => ({ ...state, [key]: null }))]) {
    await writeFile(join(root, 'runs/run/state.json'), JSON.stringify(bad)); await expect(store.read(root, 'run')).rejects.toThrow('malformed run state')
  }
  await store.writeState(root, state)
  for (const bad of [null, { jobId: 1 }]) { await writeFile(join(root, 'runs/run/job.json'), JSON.stringify(bad)); await expect(store.read(root, 'run')).rejects.toThrow('malformed run job') }
})

it('lists runs in date order, ignores temporary files, and surfaces directory failures', async () => {
  const root = await directory(); const store = new FileJevRunStore(); expect(await store.list(root)).toEqual([])
  await mkdir(join(root, 'runs')); await writeFile(join(root, 'runs', 'partial.tmp'), 'partial')
  await store.create(root, definition); await store.create(root, { ...definition, id: 'newer', createdAt: '2026-09-02' })
  const provider = new MemoryJev(new Context(), { answers: { risk: scoreAnswer(1) } }); const runs = new DurableJevRuns(new JevRunEngine(provider), store)
  expect((await runs.list(root)).map(value => value.definition.id)).toEqual(['newer', 'run'])
  const seen: number[] = []; await runs.execute(root, 'run', { onState: (value) => { seen.push(value.completed) } }); expect(seen).toEqual([0, 1, 1])
  const broken = await directory(); await writeFile(join(broken, 'runs'), 'file'); await expect(store.list(broken)).rejects.toThrow()
})

it('rejects duplicate or concurrently active runs and retries changed or removed evidence', async () => {
  const provider = new MemoryJev(new Context(), { answers: { risk: scoreAnswer(1) } }); const engine = new JevRunEngine(provider)
  await expect(engine.run({ ...definition, checks: [...definition.checks, ...definition.checks] })).rejects.toThrow('unique')
  let release: (() => void) | undefined; const wait = new Promise<void>((resolve) => { release = resolve })
  const pending = engine.run(definition, undefined, { validate: () => wait })
  expect(engine.isActive(definition.id)).toBe(true)
  expect(engine.recover(initialJevRunState(definition)).status).toBe('planned')
  await expect(engine.run(definition)).rejects.toThrow('already active'); release?.(); const completed = await pending
  expect(engine.isActive(definition.id)).toBe(false)
  await engine.run({ ...definition, checks: definition.checks.map(check => ({ ...check, evidenceDigest: 'changed' })) }, completed)
  await engine.run({ ...definition, checks: [] }, completed)
  expect(provider.calls).toHaveLength(2)
})

it('records typed validation failures and distinguishes cancellation from ordinary errors', async () => {
  const engine = new JevRunEngine(new MemoryJev(new Context(), { answers: {} }))
  for (const error of ['untyped failure', null, { code: 'UNKNOWN' }, { code: 'JEV_CREDENTIAL_MISSING' }]) {
    // The public validation hook may reject with arbitrary caller-owned values.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    const state = await engine.run(definition, undefined, { validate: () => Promise.reject(error) })
    expect(state.status).toBe('completed-with-errors'); expect(state.results[0]?.error?.code).toBe(error !== null && typeof error === 'object' && error.code === 'JEV_CREDENTIAL_MISSING' ? 'JEV_CREDENTIAL_MISSING' : 'JEV_UNAVAILABLE')
  }
  expect((await engine.run(definition, undefined, { validate: () => Promise.reject(Object.assign(new Error('cancelled'), { code: 'JEV_ABORTED' })) })).status).toBe('cancelled')
  const controller = new AbortController()
  expect((await engine.run(definition, undefined, { validate: () => { controller.abort(); return Promise.reject(new Error('cancelled')) } }, controller.signal)).status).toBe('cancelled')
})
