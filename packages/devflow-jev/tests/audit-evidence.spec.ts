/* oxlint-disable @stylistic/max-len */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevCard, DevflowJournalEntry } from '@zhchxiao123/dsh-devflow'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { afterEach, expect, it } from 'vitest'
import { collectEvidence } from '../src/evidence.ts'
import { aggregate, initialState, planAudit } from '../src/audit.ts'
import type { AuditManifest, CardEvidence, EvaluationRecord } from '../src/types.ts'

const roots: string[] = []; const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'jev-audit-evidence-')); roots.push(root); return root }
function card(root: string): DevCard { return { id: DevflowCardId('0001-card'), root, title: 'Card', body: 'Acceptance.', stage: 'draft', stageRevision: 1, serviceClass: 'standard', createdAt: 'now', updatedAt: 'now', path: join(root, 'tasks/0001-card/card.md'), artifacts: [], artifactRecords: [] } }

it('bounds body, journal and artifact bytes, relates parent/children and reports filesystem gaps', async () => {
  const root = await directory(); const value = card(root); const dir = join(root, 'tasks', value.id); await mkdir(dir, { recursive: true })
  const parent = { ...card(root), id: DevflowCardId('0000-parent'), title: 'Parent' }; value.parent = parent.id
  const child = { ...card(root), id: DevflowCardId('0002-child'), parent: value.id }
  value.title = 't'.repeat(1023) + '中'; value.body = 'b'.repeat(32767) + '中'
  await mkdir(join(dir, 'folder')); await writeFile(join(dir, 'unreadable.md'), 'restricted'); await chmod(join(dir, 'unreadable.md'), 0)
  await writeFile(join(dir, 'large.md'), 'x'.repeat(16385)); await writeFile(join(dir, 'inside.md'), 'local artifact')
  await symlink(join(dir, 'inside.md'), join(dir, 'link.md'))
  await symlink(join(root, 'outside.md'), join(dir, 'outside-link.md')); await writeFile(join(root, 'outside.md'), 'outside')
  const paths = ['', '../outside.md', '/absolute.md', 'nested//file.md', '.env', 'credentials', 'private.pem', 'missing.md', 'folder', 'unreadable.md', 'large.md', 'link.md', 'outside-link.md']
  for (let index = 0; index < 5; index++) { const path = `full-${index}.md`; await writeFile(join(dir, path), 'x'.repeat(16384)); paths.push(path) }
  value.artifactRecords = paths.map(path => ({ path, rev: 1, stage: 'draft' }))
  const journal: DevflowJournalEntry[] = [{ type: 'created', rev: 1, at: 'now', by: { kind: 'human', name: 'x'.repeat(128 * 1024) } }]
  try {
    const evidence = await collectEvidence(root, value, [parent, value, child], journal)
    expect(evidence.card.title).not.toContain('�'); expect(evidence.card.body).not.toContain('�')
    expect(evidence.relations.parent?.id).toBe(parent.id); expect(evidence.relations.children.map(entry => entry.id)).toEqual([child.id])
    expect(evidence.artifacts).toHaveLength(4); expect(evidence.journal).toEqual([])
    expect(evidence.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['unsafe', 'unreadable', 'missing', 'oversized']))
    expect(evidence.gaps.find(gap => gap.path === 'full-4.md')?.detail).toContain('budget is exhausted')
    expect(evidence.gaps.find(gap => gap.path === 'folder')?.detail).toContain('not a regular file')
    expect(evidence.gaps.find(gap => gap.path === 'journal.jsonl')?.detail).toContain('omitted')
  } finally { await chmod(join(dir, 'unreadable.md'), 0o600) }
  const absentParent = await collectEvidence(root, { ...card(root), parent: parent.id }, [], [])
  expect(absentParent.relations.parent).toBeUndefined()
})

it('stratifies real persisted cards across stages and filters completed or irrelevant stages', async () => {
  const root = await directory(); const ctx = new Context(); contexts.push(ctx); await ctx.plugin(FilesystemDevflowStore, { root }).await()
  const stages = ['draft', 'draft', 'designing', 'developing', 'reviewing', 'ready', 'testing', 'done'] as const
  const chain = ['draft', 'designing', 'developing', 'reviewing', 'ready', 'testing', 'done'] as const
  for (const [index, stage] of stages.entries()) {
    const dir = join(root, 'tasks', `000${index}-card`); await mkdir(dir, { recursive: true })
    const entries: object[] = [{ rev: 1, type: 'created', at: 'now', by: { kind: 'human' } }]
    for (let step = 1; step <= chain.indexOf(stage); step++) entries.push({ rev: step + 1, type: 'transition', from: chain[step - 1], to: chain[step], at: 'now', by: { kind: 'human' } })
    await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${index}\n---\n\nAcceptance.\n`)
    await writeFile(join(dir, 'journal.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  }
  const plan = await planAudit(ctx.devflow, root, 'full', 3)
  expect(new Set(plan.manifest.checks.map(check => check.stage))).toEqual(new Set(['draft', 'designing', 'developing']))
  const all = await planAudit(ctx.devflow, root, 'full', 100); expect(all.manifest.cardCount).toBe(7)
  const release = await planAudit(ctx.devflow, root, 'release', 100)
  expect(release.manifest.checks.every(check => ['test-impact', 'release-readiness'].includes(check.assessmentKind))).toBe(true)
})

const manifest: AuditManifest = { id: 'audit', root: '/project', profile: 'full', createdAt: 'now', cardCount: 1, checks: [{ id: 'check', cardId: 'card', cardTitle: 'Card', stage: 'testing', stageRevision: 1, assessmentKind: 'release-readiness', evidenceDigest: 'digest', rubricVersion: '3' }] }
const evaluation: EvaluationRecord = { id: 'evaluation', root: '/project', subject: { kind: 'card', cardId: 'card', title: 'Card', stage: 'testing', stageRevision: 1, digest: 'digest' }, assessmentKind: 'release-readiness', rubricVersion: '3', status: 'review', decision: 'continue', confidence: 1, answers: {}, reasons: [], missingInformation: [], recommendedServiceClass: 'standard', createdAt: 'now' }
const evidence: CardEvidence = { card: { id: 'card', title: 'Card', body: 'Acceptance', stage: 'testing', stageRevision: 1, serviceClass: 'standard' }, journal: [{ type: 'artifact', rev: 1, at: 'now', path: 'test.md', stage: 'testing', kind: 'test-report' }], artifacts: [{ path: 'test.md', kind: 'test-report', digest: 'digest', excerpt: 'passed', truncated: false }], gaps: [], relations: { children: [] } }

it('aggregates blocking findings, warnings, stale snapshots and duplicate evidence deterministically', () => {
  const check = manifest.checks[0]; if (check === undefined) throw new Error('missing fixture check')
  const complete = { ...initialState(manifest), completed: 1, results: [{ check, status: 'completed' as const, completedAt: 'now' }] }
  expect(aggregate(manifest, complete, [{ ...evaluation, evidence }]).conclusion).toBe('healthy')
  expect(aggregate(manifest, complete, [{ ...evaluation, evidence }]).report).toContain('No findings.')
  const unsafe: EvaluationRecord = { ...evaluation, evidence: { ...evidence, journal: [], gaps: [{ kind: 'missing', path: 'test.md', detail: 'Missing test.' }], relations: { children: [{ id: 'child', title: 'Child', stage: 'developing', stageRevision: 1 }, { id: 'done', title: 'Done', stage: 'done', stageRevision: 1 }] } }, answers: {
    releaseDecision: { type: 'choice', choice: 'blocked', probabilities: { blocked: 1 }, confidence: 1 }, changeRisk: { type: 'score', score: 3.5, probabilities: [], confidence: 1 }, acceptanceExecutable: { type: 'noul', noul: 0.4 }, behaviorChanged: { type: 'noul', noul: 0.8 }, specificationCovered: { type: 'noul', noul: 0.4 },
  } }
  const blocked = aggregate(manifest, complete, [unsafe, unsafe]); expect(blocked.conclusion).toBe('blocked')
  expect(blocked.findings.map(finding => finding.code)).toEqual(['evidence-missing', 'release-not-ready', 'implementation-risk', 'acceptance-not-executable', 'test-evidence-stale', 'spec-delta', 'active-child'])
  const warning: EvaluationRecord = { ...evaluation, assessmentKind: 'implementation-risk', subject: { kind: 'request', title: 'Request', body: 'Body', digest: 'digest' }, evidence: { ...evidence, gaps: [{ kind: 'unreadable', path: 'a', detail: 'Unreadable.' }] }, answers: { changeRisk: { type: 'score', score: 3, probabilities: [], confidence: 1 } } }
  const attention = aggregate(manifest, complete, [warning]); expect(attention.conclusion).toBe('attention-required'); expect(attention.report).toContain('Implementation risk')
  expect(aggregate(manifest, initialState(manifest), [{ ...evaluation, status: 'unavailable' }]).conclusion).toBe('unavailable')
  expect(aggregate(manifest, initialState(manifest), []).conclusion).toBe('incomplete')
  const stale = aggregate(manifest, { ...initialState(manifest), results: [{ check, status: 'stale', completedAt: 'now' }, { check, status: 'stale', error: 'Changed revision.', completedAt: 'now' }] }, [])
  expect(stale.findings.map(finding => finding.message)).toEqual(expect.arrayContaining(['release-readiness: evidence changed after the audit snapshot', 'release-readiness: Changed revision.']))
  expect(aggregate(manifest, complete, [{ ...evaluation, answers: { releaseDecision: { type: 'choice', choice: 'unavailable', probabilities: { unavailable: 1 }, confidence: 1 } } }]).conclusion).toBe('blocked')
  expect(aggregate(manifest, complete, [{ ...evaluation, evidence, answers: { releaseDecision: { type: 'choice', choice: 'ready', probabilities: { ready: 1 }, confidence: 1 }, behaviorChanged: { type: 'noul', noul: 0.8 }, specificationCovered: { type: 'noul', noul: 0.9 } } }]).conclusion).toBe('healthy')
})
