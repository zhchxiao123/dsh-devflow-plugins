/* oxlint-disable @stylistic/max-len */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AuditStore } from '../src/audit-store.ts'
import { initialState } from '../src/audit.ts'
import type { AuditCheck, AuditManifest, EvaluationRecord } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'jev-audit-storage-')); roots.push(root); return root }
const check: AuditCheck = { id: 'a'.repeat(20), cardId: '0001-card', cardTitle: 'Card', stage: 'draft', stageRevision: 1, assessmentKind: 'planning', evidenceDigest: 'digest', rubricVersion: '3' }
function manifest(root: string): AuditManifest { return { id: randomUUID(), root, profile: 'full', createdAt: '2026-09-01', cardCount: 1, checks: [check] } }
const evaluation: EvaluationRecord = { id: 'evaluation', root: '/project', subject: { kind: 'request', title: 'Request', body: 'Do work.', digest: 'digest' }, assessmentKind: 'planning', rubricVersion: '3', status: 'review', decision: 'continue', confidence: 1, answers: {}, reasons: [], missingInformation: [], recommendedServiceClass: 'standard', createdAt: '2026-09-01' }

it('persists audit snapshots, bindings, evaluations, and readable reports across a new store', async () => {
  const root = await directory(); const store = new AuditStore(); const first = manifest(root); const second = { ...manifest(root), createdAt: '2026-09-02' }
  expect(await store.list(root)).toEqual([])
  await store.create(first, initialState(first)); await store.create(second, initialState(second))
  await writeFile(join(root, 'judgements/audits', 'partial.tmp'), 'partial')
  expect(await store.job(root, first.id)).toBeUndefined(); expect(await store.evaluation(root, first.id, check.id)).toBeUndefined()
  await store.bindJob(root, first.id, 'job-1'); await store.writeEvaluation(root, first.id, check.id, evaluation)
  await store.writeState(root, { ...initialState(first), status: 'completed' }); await store.writeReport(root, first.id, [], '# Audit passed\n')
  const reopened = new AuditStore()
  expect((await reopened.list(root)).map(item => item.manifest.id)).toEqual([second.id, first.id])
  expect((await reopened.inspect(root, first.id)).state).toMatchObject({ jobId: 'job-1', status: 'completed' })
  expect(await reopened.evaluation(root, first.id, check.id)).toEqual(evaluation)
  expect(await readFile(join(root, 'judgements/audits', first.id, 'report.md'), 'utf8')).toBe('# Audit passed\n')
})

it('rejects corrupt manifest and state fields instead of trusting partial durable records', async () => {
  const root = await directory(); const store = new AuditStore(); const value = manifest(root); await store.create(value, initialState(value))
  const dir = join(root, 'judgements/audits', value.id)
  for (const bad of [null, [], 1, ...['id', 'root', 'profile', 'createdAt', 'cardCount', 'checks'].map(key => ({ ...value, [key]: null })),
    ...[null, ...['id', 'cardId', 'assessmentKind', 'evidenceDigest'].map(key => ({ ...check, [key]: null }))].map(entry => ({ ...value, checks: [entry] }))]) {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(bad)); await expect(store.manifest(root, value.id)).rejects.toThrow('malformed')
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...value, checks: [{ ...check, id: '../outside' }] }))
  await expect(store.manifest(root, value.id)).rejects.toThrow('invalid audit check id')
  for (const bad of [null, ...['runId', 'status', 'total', 'completed', 'failed', 'results', 'findings', 'createdAt'].map(key => ({ ...initialState(value), [key]: null }))]) {
    await writeFile(join(dir, 'state.json'), JSON.stringify(bad)); await expect(store.state(root, value.id)).rejects.toThrow('malformed audit state')
  }
})

it('surfaces malformed optional records, traversal, and listing I/O failures', async () => {
  const root = await directory(); const store = new AuditStore(); const value = manifest(root); await store.create(value, initialState(value))
  const dir = join(root, 'judgements/audits', value.id)
  for (const bad of [null, { jobId: 7 }]) { await writeFile(join(dir, 'job.json'), JSON.stringify(bad)); await expect(store.job(root, value.id)).rejects.toThrow('malformed audit job') }
  for (const bad of [null, ...['id', 'assessmentKind', 'createdAt'].map(key => ({ ...evaluation, [key]: null }))]) {
    await writeFile(join(dir, 'evaluations', `${check.id}.json`), JSON.stringify(bad)); await expect(store.evaluation(root, value.id, check.id)).rejects.toThrow('malformed audit evaluation')
  }
  await expect(store.manifest(root, '../escape')).rejects.toThrow('invalid audit run id')
  await expect(store.evaluation(root, value.id, '../escape')).rejects.toThrow('invalid audit check id')
  const broken = await directory(); await mkdir(join(broken, 'judgements')); await writeFile(join(broken, 'judgements/audits'), 'file')
  await expect(store.list(broken)).rejects.toThrow()
})
