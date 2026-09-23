import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { DurableJevRuns, JevRunEngine } from '@zhchxiao123/dsh-jev'
import { MemoryJev, scoreAnswer } from './memory.ts'

describe('DurableJevRuns', () => {
  it('persists and resumes a generic repository run without Devflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jev-runs-')); const provider = new MemoryJev(new Context(), { answers: { fit: scoreAnswer(1) } }); const runs = new DurableJevRuns(new JevRunEngine(provider))
    await runs.prepare(root, { id: 'repo-health-1', scope: { kind: 'repository', id: '/repo', title: 'Repo' }, template: { id: 'repository-health', version: '1' }, createdAt: '2026-09-22T00:00:00.000Z', checks: [{ id: 'readme', subject: { kind: 'file', id: 'README.md', title: 'README' }, evidenceDigest: 'abc', request: { state: 'README', questions: { fit: { type: 'score', instructions: 'fit', criteria: ['bad', 'good'] } } } }] })
    expect((await runs.inspect(root, 'repo-health-1')).state.status).toBe('interrupted')
    await runs.bindJob(root, 'repo-health-1', 'jev-run-1')
    const completed = await runs.execute(root, 'repo-health-1'); expect(completed.state.status).toBe('completed')
    const persisted: unknown = JSON.parse(await readFile(join(root, 'runs/repo-health-1/state.json'), 'utf8'))
    expect(Reflect.get(persisted as object, 'completed')).toBe(1)
    expect((await runs.inspect(root, 'repo-health-1')).state.jobId).toBe('jev-run-1')
  })

  it('rejects traversal run ids at the storage seam', async () => {
    const runs = new DurableJevRuns(new JevRunEngine(new MemoryJev(new Context())))
    await expect(runs.inspect('/tmp', '../outside')).rejects.toThrow('invalid run id')
  })

  it('validates a complete definition before creating durable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jev-runs-invalid-')); const runs = new DurableJevRuns(new JevRunEngine(new MemoryJev(new Context())))
    await expect(runs.prepare(root, { id: 'invalid', scope: undefined, template: { id: 'test', version: '1' }, createdAt: '2026-09-22T00:00:00.000Z', checks: [] } as never)).rejects.toThrow('malformed run scope')
    await expect(access(join(root, 'runs/invalid'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects malformed subjects and duplicate check ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jev-runs-invalid-checks-')); const runs = new DurableJevRuns(new JevRunEngine(new MemoryJev(new Context())))
    const base = { id: 'invalid-checks', scope: { kind: 'repository', id: '/repo', title: 'Repo' }, template: { id: 'test', version: '1' }, createdAt: '2026-09-22T00:00:00.000Z' }
    await expect(runs.prepare(root, { ...base, checks: [{ id: 'a', subject: {}, evidenceDigest: 'x', request: { state: {}, questions: {} } }] } as never)).rejects.toThrow('malformed run check')
    const check = { id: 'a', subject: { kind: 'file', id: 'a', title: 'a' }, evidenceDigest: 'x', request: { state: {}, questions: {} } }
    await expect(runs.prepare(root, { ...base, checks: [check, check] })).rejects.toThrow('malformed run check')
  })
})
