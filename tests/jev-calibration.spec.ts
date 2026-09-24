// The calibration export is read-only bookkeeping: every readable judgement
// answer becomes one typed row, human verdicts become labels, gate journal
// checks become edge joins, and any group below the labeled floor says it is
// unusable for threshold tuning instead of printing a confident-looking rate.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MINIMUM_LABELED, exportCalibration, gateEdgesFromJournal, languageOf, renderSummary, rowsFromEvaluation, summarize,
} from '../scripts/jev-calibration.ts'

let root: string | undefined
afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })

function evaluation(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id, root: '/r', subject: { kind: 'card', cardId: '0001-card', title: 'Ship the fence', stage: 'testing', stageRevision: 1, digest: 'd' },
    assessmentKind: 'release-readiness', rubricVersion: '4', status: 'review', decision: 'continue', confidence: 0.9,
    answers: {
      releaseDecision: { type: 'choice', choice: 'ready', probabilities: { ready: 0.9, blocked: 0.1 }, confidence: 0.8 },
      requiredEvidencePresent: { type: 'noul', noul: 0.95 },
    },
    reasons: [], missingInformation: [], recommendedServiceClass: 'standard', createdAt: 'now', ...overrides,
  }
}

describe('languageOf', () => {
  it.each([
    ['Deliver the release fence', 'latin'],
    ['把评审门禁交付出去', 'cjk'],
    ['release 门禁 with 中文 mixed evidence text', 'mixed'],
    ['12345 --- 6789', 'unknown'],
  ] as const)('classifies %j as %s', (text, language) => {
    expect(languageOf(text)).toBe(language)
  })
})

describe('gateEdgesFromJournal', () => {
  it('joins evaluation ids to the edges the gate recorded, ignoring other gates and torn lines', () => {
    const journal = [
      JSON.stringify({ rev: 5, type: 'transition', from: 'developing', to: 'reviewing', gate: { checks: [
        { by: { kind: 'command', name: 'devflow-jev-gate' }, verdict: 'allowed', summary: 'jev implementation-risk [aaaa-1111]: changeRisk=1.00(c0.90)' },
        { by: { kind: 'command', name: 'other-gate' }, verdict: 'allowed', summary: 'not ours [bbbb-2222]' },
      ] } }),
      '{ torn',
      JSON.stringify({ rev: 6, type: 'transition', from: 'reviewing', to: 'testing' }),
    ].join('\n')
    expect(gateEdgesFromJournal(journal)).toEqual(new Map([['aaaa-1111', ['developing->reviewing']]]))
  })
})

describe('summarize', () => {
  it('keeps answer types in separate groups and flags every under-labeled group', () => {
    const rows = rowsFromEvaluation(evaluation('e1', { status: 'accepted' }), new Map())
    if (rows === undefined) throw new Error('expected rows')
    const groups = summarize(rows)
    expect(groups.map(group => `${group.answerType}/${group.language}`)).toEqual(['choice/latin', 'noul/latin'])
    for (const group of groups) {
      expect(group.labeled).toBeLessThan(MINIMUM_LABELED)
      expect(group.insufficientForThresholds).toBe(true)
    }
    expect(renderSummary(groups, [])).toContain('insufficient for thresholds')
  })
})

describe('exportCalibration', () => {
  it('scans evaluations, assistance, and journals into a dataset and a summary, skipping unreadable files', async () => {
    root = await mkdtemp(join(tmpdir(), 'jev-calibration-'))
    const evaluations = join(root, 'judgements', 'evaluations')
    await mkdir(evaluations, { recursive: true })
    await writeFile(join(evaluations, 'e1.json'), JSON.stringify(evaluation('aaaa-1111', { status: 'accepted' })))
    await writeFile(join(evaluations, 'e2.json'), JSON.stringify(evaluation('cccc-3333', {
      status: 'rejected',
      subject: { kind: 'request', title: '修复门禁', body: '评审门禁在中文证据上误判。', digest: 'd' },
      proposedTitle: '修复门禁', proposedBody: '评审门禁在中文证据上误判。',
      answers: { value: { type: 'score', score: 3, probabilities: [0, 0, 0, 1, 0], confidence: 0.95 } },
    })))
    await writeFile(join(evaluations, 'broken.json'), '{ not json')
    const assistance = join(root, 'judgements', 'assistance')
    await mkdir(assistance, { recursive: true })
    await writeFile(join(assistance, 'a1.json'), JSON.stringify({ id: 'a1', action: 'inspect-failure', actionConfidence: 0.55, reason: 'The failing check repeats.', policyVersion: '3' }))
    const task = join(root, 'tasks', '0001-card')
    await mkdir(task, { recursive: true })
    await writeFile(join(task, 'journal.jsonl'), JSON.stringify({ rev: 5, type: 'transition', from: 'testing', to: 'done', gate: { checks: [
      { by: { kind: 'command', name: 'devflow-jev-gate' }, verdict: 'allowed', summary: 'jev release-readiness [aaaa-1111]: releaseDecision=ready@0.90' },
    ] } }) + '\n')

    const out = join(root, 'out')
    const result = await exportCalibration(root, out)

    expect(result.skipped).toEqual([join(evaluations, 'broken.json')])
    const release = result.rows.find(row => row.id === 'aaaa-1111' && row.answerId === 'releaseDecision')
    expect(release).toMatchObject({ answerType: 'choice', value: 'ready', measure: 0.8, label: 'accepted', language: 'latin', gateEdges: ['testing->done'] })
    expect(result.rows.find(row => row.id === 'cccc-3333')).toMatchObject({ answerType: 'score', label: 'rejected', language: 'cjk' })
    expect(result.rows.find(row => row.source === 'assistance')).toMatchObject({ answerId: 'action', value: 'inspect-failure', measure: 0.55 })

    const dataset = (await readFile(join(out, 'dataset.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { id: string })
    expect(dataset).toHaveLength(result.rows.length)
    const summary = await readFile(join(out, 'summary.md'), 'utf8')
    expect(summary).toContain('insufficient for thresholds')
    expect(summary).toContain('Skipped 1 unreadable file(s)')
    expect(summary).toContain('Read-only export')
  })
})
