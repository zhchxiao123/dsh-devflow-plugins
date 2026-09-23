import { describe, expect, it } from 'vitest'
import type { JevResponse } from '@zhchxiao123/dsh-jev'
import { assistanceDecision, assistanceRequest } from '../src/assistance-policy.ts'
import type { WorkspaceEvidence } from '../src/workspace-evidence.ts'

const evidence: WorkspaceEvidence = { workspace: '/project', head: 'head', status: 'M archive.ts', diff: 'diff', files: [{ path: 'archive.ts', excerpt: 'export const archived = true', digest: 'content' }], untracked: [], gaps: [], digest: 'snapshot' }
function response(action = 'review-change', focus = 'file0', confidence = 0.9, target = 'scope'): JevResponse {
  return { answers: {
    action: { type: 'choice', choice: action, confidence, probabilities: { [action]: 1 } },
    focus: { type: 'choice', choice: focus, confidence: 1, probabilities: { [focus]: 1 } },
    justified: { type: 'noul', noul: confidence },
    target: { type: 'choice', choice: target, confidence: 1, probabilities: { [target]: 1 } },
  } }
}
describe('bounded assistance action policy', () => {
  it('offers file references from the collected evidence and keeps untrusted text in state', () => {
    const request = assistanceRequest('completion', 'Implement archive.', evidence, ['test failed'], ['read', 'bash'])
    expect(request.questions.focus).toMatchObject({ type: 'choice', criteria: { file0: 'archive.ts' } })
    expect(request.state).toContain('untrusted evidence')
    expect(assistanceDecision(response(), evidence, 0.75)).toMatchObject({ action: 'review-change', evidenceRefs: ['archive.ts'] })
    expect(assistanceDecision(response(), evidence, 0.75).reason).toContain('archive.ts')
    expect(assistanceDecision(response('read-evidence', 'scope'), evidence, 0.75).evidenceRefs).toEqual([])
  })
  it('abstains when an otherwise valid action lacks sufficient support', () => {
    expect(assistanceDecision(response('review-change', 'file0', 0.4), evidence, 0.75).action).toBe('continue')
    expect(assistanceDecision(response('continue', 'scope'), evidence, 0.75).reason).toContain('continue the existing workflow')
  })
  it('rejects missing answers, invalid choices, and evidence references outside the snapshot', () => {
    const valid = response()
    for (const key of ['action', 'focus', 'justified', 'target']) {
      const answers = Object.fromEntries(Object.entries(valid.answers).filter(([name]) => name !== key))
      expect(() => assistanceDecision({ answers }, evidence, 0.75)).toThrow('incomplete assistance judgement')
    }
    for (const action of ['arbitrary-shell', 'constructor', '__proto__']) expect(() => assistanceDecision(response(action), evidence, 0.75)).toThrow('incomplete assistance judgement')
    for (const focus of ['../../private', 'file99']) expect(() => assistanceDecision(response('review-change', focus), evidence, 0.75)).toThrow('invalid assistance evidence reference')
    for (const confidence of [-0.1, 1.1, Number.NaN]) expect(() => assistanceDecision(response('review-change', 'file0', confidence), evidence, 0.75)).toThrow('invalid assistance confidence')
    expect(() => assistanceDecision(response('review-change', 'file0', 0.9, 'target99'), evidence, 0.75)).toThrow('incomplete assistance judgement')
  })
  it('selects concrete supplied requirements and failed checks without claiming a confirmed defect', () => {
    const task = '归档后默认隐藏。恢复后重新显示；重启后状态保持'
    const outcomes = ['bash: pnpm test\nfailed\nExpected persistence after restart', 'bash: pnpm lint\ncheck completed\nsuccess']
    const request = assistanceRequest('completion', task, evidence, outcomes, ['read'])
    expect(request.questions.target).toMatchObject({ type: 'choice', criteria: {
      target0: 'failure: bash: pnpm test failed Expected persistence after restart',
      target1: 'requirement: 归档后默认隐藏', target2: 'requirement: 恢复后重新显示', target3: 'requirement: 重启后状态保持',
    } })
    const failed = assistanceDecision(response('inspect-failure', 'file0', 0.9, 'target0'), evidence, 0.75, task, outcomes)
    expect(failed.reason).toContain('Suggested investigation (unverified): failure: bash: pnpm test failed Expected persistence after restart')
    const requirement = assistanceDecision(response('add-verification', 'file0', 0.9, 'target3'), evidence, 0.75, task, outcomes)
    expect(requirement.reason).toContain('requirement: 重启后状态保持')
  })
  it('reads card requirements from registered evidence and keeps malformed JSON as quoted data', () => {
    const cardTask = JSON.stringify({ card: { body: 'Acceptance one\nAcceptance two' }, other: 'Do not turn metadata into requirement choices.' })
    expect(assistanceRequest('planning', cardTask, evidence, [], ['read']).questions.target)
      .toMatchObject({ type: 'choice', criteria: { target0: 'requirement: Acceptance one', target1: 'requirement: Acceptance two' } })
    for (const task of ['{truncated', '{}', '{"card":null}', '{"card":{}}', '{"card":{"body":1}}']) {
      expect(assistanceRequest('planning', task, evidence, [], ['read']).questions.target)
        .toMatchObject({ type: 'choice', criteria: { target0: `requirement: ${task}` } })
    }
    const bounded = assistanceRequest('planning', Array.from({ length: 100 }, (_, index) => `Requirement ${index}`).join('\n'), evidence, [], ['read']).questions.target
    if (bounded?.type !== 'choice') throw new Error('target choice unavailable')
    expect(Object.keys(bounded.criteria)).toHaveLength(50)
  })
})
