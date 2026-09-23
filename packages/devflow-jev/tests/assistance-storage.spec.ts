import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assistanceConfig } from '../src/assistance-config.ts'
import { AssistanceStore } from '../src/assistance-store.ts'
import type { AssistanceRecord } from '../src/assistance-types.ts'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { force: true, recursive: true }) })
async function workspace(): Promise<string> { const path = await realpath(await mkdtemp(join(tmpdir(), 'jev-assistance-store-'))); paths.push(path); return path }
function record(project: string): AssistanceRecord {
  return { id: randomUUID(), workspace: project, sessionId: 'owner', turn: 1, event: 'planning', mode: 'assist', evidenceDigest: 'digest', policyVersion: '1',
    action: 'read-evidence', reason: 'Read the persistence implementation.', evidenceRefs: ['archive.ts'], gaps: [], confidence: 0.9,
    status: 'delivering', outcome: 'unknown', elapsedMs: 1, createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z' }
}
describe('assistance configuration and persisted records', () => {
  it('defaults to observation and rejects invalid deployment budgets', () => {
    expect(assistanceConfig().mode).toBe('observe')
    for (const key of ['timeoutMs', 'maxCallsPerTurn', 'maxSteersPerTurn', 'maxBytes', 'maxFiles', 'maxFileBytes', 'repeatThreshold'] as const) {
      for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => assistanceConfig({ [key]: value })).toThrow('positive integer')
    }
    for (const confidenceFloor of [-1, 2, Number.NaN]) expect(() => assistanceConfig({ confidenceFloor })).toThrow('between 0 and 1')
    expect(() => assistanceConfig({ mode: 'invalid' as 'observe' })).toThrow('invalid assistance mode')
    expect(() => assistanceConfig({ maxFiles: 50 })).toThrow('50 JEV choices')
  })
  it('persists delivery intent and reads it unchanged after restart', async () => {
    const project = await workspace(); const store = new AssistanceStore(); const entry = record(project)
    expect(await store.list(project)).toEqual([])
    await store.write(project, entry)
    await writeFile(join(project, '.devflow', 'judgements', 'assistance', 'unfinished.tmp'), 'partial')
    const restarted = new AssistanceStore()
    expect(await restarted.read(project, entry.id)).toEqual(entry)
    expect(await restarted.list(project)).toEqual([entry])
    const path = join(project, '.devflow', 'judgements', 'assistance', `${entry.id}.json`)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(entry)
    const later = { ...record(project), createdAt: '2026-09-24T00:00:00.000Z' }
    await store.write(project, later)
    expect(await restarted.list(project)).toEqual([later, entry])
  })
  it('rejects path traversal, invalid records, and tampered durable content', async () => {
    const project = await workspace(); const store = new AssistanceStore(); const entry = record(project)
    await expect(store.read(project, '../outside')).rejects.toThrow('invalid assistance id')
    await expect(store.write(project, { ...entry, confidence: 2 })).rejects.toThrow('invalid assistance record')
    await expect(store.write(project, { ...entry, inputTokens: Number.POSITIVE_INFINITY })).rejects.toThrow('invalid assistance record')
    await expect(store.write(project, { ...entry, actionConfidence: Number.POSITIVE_INFINITY })).rejects.toThrow('invalid assistance record')
    await store.write(project, entry)
    await writeFile(join(project, '.devflow', 'judgements', 'assistance', `${entry.id}.json`), JSON.stringify({ ...entry, id: randomUUID() }))
    await expect(store.read(project, entry.id)).rejects.toThrow('malformed assistance record')
  })
  it('does not follow assistance directories or records outside the project', async () => {
    const outside = await workspace(); const project = await workspace(); const store = new AssistanceStore(); const entry = record(project)
    await symlink(outside, join(project, '.devflow'))
    await expect(store.write(project, entry)).rejects.toThrow('unsafe assistance directory')
    await rm(join(project, '.devflow'))
    await store.write(project, entry)
    const target = join(project, '.devflow', 'judgements', 'assistance', `${entry.id}.json`)
    await rm(target)
    await writeFile(join(outside, 'private.json'), JSON.stringify(entry))
    await symlink(join(outside, 'private.json'), target)
    await expect(store.read(project, entry.id)).rejects.toThrow('unsafe assistance record')
  })
  it('rejects a directory where a record file is expected', async () => {
    const project = await workspace(); const store = new AssistanceStore(); const entry = record(project)
    await mkdir(join(project, '.devflow', 'judgements', 'assistance', `${entry.id}.json`), { recursive: true })
    await expect(store.read(project, entry.id)).rejects.toThrow('unsafe assistance record')
  })
  it('rejects malformed history instead of presenting it as a trustworthy recommendation', async () => {
    const project = await workspace(); const store = new AssistanceStore(); const entry = record(project)
    await store.write(project, entry)
    const path = join(project, '.devflow', 'judgements', 'assistance', `${entry.id}.json`)
    const corruptions: unknown[] = [null, 'record', { ...entry, reason: 1 }, { ...entry, id: '../escape' },
      { ...entry, confidence: -1 }, { ...entry, turn: 'one' }, { ...entry, event: 1 }, { ...entry, mode: 'automatic' },
      { ...entry, status: 'verified' }, { ...entry, event: 'unknown' }, { ...entry, action: 'execute-shell' },
      { ...entry, outcome: 'proved-correct' }, { ...entry, evidenceRefs: 'archive.ts' }, { ...entry, gaps: [1] },
      { ...entry, card: null }, { ...entry, card: 'card' }, { ...entry, card: { id: 1, stage: 'draft', title: 'A', revision: 1 } },
      { ...entry, card: { id: 'card', stage: 'draft', title: 'A', revision: 1.5 } }, { ...entry, model: 2 },
      { ...entry, inputTokens: '100' }, { ...entry, inputTokens: -1 }, { ...entry, outputTokens: null }, { ...entry, confidence: 2 },
      { ...entry, configurationStatus: 'healthy' }, { ...entry, configurationStatus: null },
      { ...entry, providerIdentity: 1 },
      ...['rawAction', 'decisionReason'].flatMap(key => [null, 1, [], ['continue'], 'invalid'].map(value => ({ ...entry, [key]: value }))),
      ...[null, 'code-changed', [1]].map(staleReasons => ({ ...entry, staleReasons })),
      { ...entry, associationReason: 1 }, { ...entry, sessionTitle: null },
      ...['actionConfidence', 'justifiedProbability'].flatMap(key => ['high', null, -0.1, 1.1].map(value => ({ ...entry, [key]: value }))) ]
    for (const corrupted of corruptions) {
      await writeFile(path, JSON.stringify(corrupted))
      await expect(store.read(project, entry.id)).rejects.toThrow('malformed assistance record')
    }
    const complete = { ...entry, card: { id: 'card', stage: 'draft', title: 'A', revision: 1 }, configurationStatus: 'configured' as const, providerIdentity: 'fixture-model-identity', actionConfidence: 1, justifiedProbability: 0, model: 'fixture', outcomeDetail: 'Unknown causality.', inputTokens: 10, outputTokens: 2,
      rawAction: 'read-evidence' as const, decisionReason: 'actionable' as const, staleReasons: ['code-changed', 'card-revision-changed'], associationReason: 'No uniquely owned card.', sessionTitle: 'Archive persistence' }
    await store.write(project, complete)
    expect(await store.read(project, entry.id)).toEqual(complete)
    for (const decisionReason of ['no-intervention', 'below-threshold'] as const) {
      const diagnostic = { ...complete, action: 'continue' as const, decisionReason, staleReasons: [] }
      await store.write(project, diagnostic)
      expect(await store.read(project, entry.id)).toEqual(diagnostic)
    }
    await writeFile(path, ' '.repeat(1024 * 1024 + 1))
    await expect(store.read(project, entry.id)).rejects.toThrow('unsafe assistance record')
  })
  it('surfaces unsafe storage and nonexistent workspaces instead of treating them as empty history', async () => {
    const project = await workspace(); const store = new AssistanceStore()
    await writeFile(join(project, '.devflow'), 'not a directory')
    await expect(store.list(project)).rejects.toThrow('unsafe assistance directory')
    await expect(store.write(join(project, 'missing'), record(project))).rejects.toThrow()
  })
  it('surfaces unwritable storage without publishing a partially saved record', async () => {
    const project = await workspace(); const store = new AssistanceStore(); const root = join(project, '.devflow')
    await mkdir(root); await chmod(root, 0o500)
    try { await expect(store.write(project, record(project))).rejects.toThrow(); expect(await store.list(project)).toEqual([]) }
    finally { await chmod(root, 0o700) }
  })
})
