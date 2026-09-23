/* oxlint-disable @stylistic/max-len */
import type { Answer, JevRequest } from '@zhchxiao123/dsh-jev'
import type { AssessmentKind, AssessmentPolicy, CardEvidence, EvaluationDecision } from './types.ts'

export const DEFAULT_POLICY: AssessmentPolicy = {
  codeSolvableFloor: 0.75,
  informationFloor: 0.6,
  valueFloor: 2.5,
  confidenceFloor: 0.7,
  maximumRisk: 3.5,
}
const LEVELS = {
  value: ['None: no meaningful user or engineering benefit', 'Low: small local benefit', 'Moderate: useful improvement with a clear beneficiary', 'High: substantial reliability, productivity, or user benefit', 'Critical: urgent or broadly blocking value'],
  risk: ['Trivial: isolated and easily reversible', 'Low: local change with established patterns', 'Moderate: multiple components or meaningful regression surface', 'High: cross-cutting, security-sensitive, or migration-heavy', 'Critical: irreversible or safety-critical impact'],
  clarity: ['Unknown: the requested outcome cannot be identified', 'Vague: intent is visible but boundaries are missing', 'Usable: enough scope to investigate or design', 'Clear: behavior and boundaries are concrete', 'Precise: acceptance conditions and exclusions are explicit'],
  coverage: ['None: no executed test evidence', 'Narrow: only a small part of the requested behavior is exercised', 'Partial: material acceptance or regression paths remain untested', 'Covered: required behavior and material regression paths are exercised', 'Comprehensive: required behavior, regressions, and relevant failure paths are exercised'],
} as const
const SPECIALIZED: Readonly<Record<AssessmentKind, JevRequest['questions']>> = {
  intake: {},
  planning: {
    acceptanceExecutable: { type: 'noul', instructions: 'Are the acceptance conditions concrete enough to verify without inventing missing product decisions?' },
    dependencyClarity: { type: 'score', instructions: 'Rate how clearly dependencies, exclusions, and failure handling are stated.', criteria: LEVELS.clarity },
  },
  'implementation-risk': {
    changeRisk: { type: 'score', instructions: 'Rate implementation risk from affected modules, compatibility, migrations, concurrency, security, and reversibility.', criteria: LEVELS.risk },
    riskControlled: { type: 'noul', instructions: 'Does the supplied evidence contain concrete controls for the material implementation risks?' },
  },
  'test-impact': {
    testCoverage: { type: 'score', instructions: 'Rate how well the registered executed test evidence covers the requested behavior and regression surface. Test plans and command success alone do not establish behavior coverage.', criteria: LEVELS.coverage },
    testEvidenceFresh: { type: 'noul', instructions: 'Is there test evidence tied to the current card revision rather than only a plan or an older result?' },
  },
  'review-scope': {
    reviewBreadth: { type: 'score', instructions: 'Rate the breadth of review expertise and repository surface this work requires.', criteria: LEVELS.risk },
    scopeAligned: { type: 'noul', instructions: 'Does the available implementation and review evidence remain within the card scope?' },
  },
  'release-readiness': {
    requiredEvidencePresent: { type: 'noul', instructions: 'Are the required tests, validators, deployment facts, and rollback evidence present and current?' },
    releaseDecision: { type: 'choice', instructions: 'Choose the release posture justified only by the supplied evidence.', criteria: { ready: 'All material evidence is present and current.', conditional: 'Minor explicit conditions remain without a blocking risk.', blocked: 'A required check, dependency, or deployment fact is missing or failed.', unavailable: 'The evidence cannot support a release judgement.' } },
  },
  'spec-delta': {
    behaviorChanged: { type: 'noul', instructions: 'Does this work change a durable behavior or contract rather than only implementation detail?' },
    specificationCovered: { type: 'noul', instructions: 'When behavior changes, do current registered requirements or design artifacts describe the new contract?' },
  },
}
export const RUBRIC_VERSION = '3'
export function assessmentRequest(state: Readonly<Record<string, unknown>>, kind: AssessmentKind): JevRequest {
  return { state: { ...state, task: `Devflow ${kind} assessment`, assessmentKind: kind }, questions: kind === 'intake' ? intakeQuestions() : SPECIALIZED[kind] }
}
function intakeQuestions(): JevRequest['questions'] {
  return {
    codeSolvable: { type: 'noul', instructions: 'Can the requested outcome primarily be achieved by changing code, configuration, tests, or repository documentation?', criteria: { true: 'A repository change can materially deliver the outcome.', false: 'The outcome primarily needs a business, account, operational, or human action outside the repository.' } },
    informationSufficient: { type: 'noul', instructions: 'Is the supplied evidence sufficient to create a useful Devflow task that an engineer can start investigating or designing?', criteria: { true: 'The task can state a concrete outcome and useful acceptance boundary.', false: 'Essential context is missing and a task would only restate the question.' } },
    value: { type: 'score', instructions: 'Rate the likely value of completing this work.', criteria: LEVELS.value },
    risk: { type: 'score', instructions: 'Rate implementation and regression risk. Judge uncertainty as risk rather than silently assuming a simple implementation.', criteria: LEVELS.risk },
    scopeClarity: { type: 'score', instructions: 'Rate how clearly the desired behavior and scope are stated.', criteria: LEVELS.clarity },
    recommendedAction: { type: 'choice', instructions: 'Choose the safest useful next action in Devflow.', criteria: {
      create: 'Create or continue a task; the work is actionable.', investigate: 'Create or continue an investigation task because the implementation path is unclear.', ask: 'Ask for missing information before creating or advancing work.', reject: 'Do not create or advance work because it is clearly not suitable for repository development.',
    } },
    serviceClass: { type: 'choice', instructions: 'Choose the Devflow service class justified by the evidence.', criteria: {
      standard: 'Normal work that should pass design, review, and testing.', express: 'Small and well-understood work that may skip design and independent verification but still needs review.', emergency: 'An active incident whose urgency justifies skipping review; choose only with explicit incident evidence.',
    } },
  }
}
export function evidenceState(evidence: CardEvidence): Readonly<Record<string, unknown>> {
  return { card: evidence.card, journal: evidence.journal, artifacts: evidence.artifacts, evidenceGaps: evidence.gaps, relations: evidence.relations }
}
function noul(answers: Readonly<Record<string, Answer>>, key: string): number | undefined { const answer = answers[key]; return answer?.type === 'noul' ? answer.noul : undefined }
function score(answers: Readonly<Record<string, Answer>>, key: string): number | undefined { const answer = answers[key]; return answer?.type === 'score' ? answer.score : undefined }
function choice(answers: Readonly<Record<string, Answer>>, key: string): string | undefined { const answer = answers[key]; return answer?.type === 'choice' ? answer.choice : undefined }
function answerConfidence(answer: Answer): number { return answer.type === 'noul' ? Math.abs(answer.noul - 0.5) * 2 : answer.confidence }
/** Stage assessments are advice; continuing never grants a transition or substitutes for required validators. */
export function decide(answers: Readonly<Record<string, Answer>>, policy: AssessmentPolicy, existingCard: boolean, kind: AssessmentKind = 'intake'): { decision: EvaluationDecision; confidence: number; reasons: string[]; missingInformation: string[]; serviceClass: 'standard' | 'express' | 'emergency' } {
  if (kind !== 'intake') return decideStage(answers, policy, existingCard, kind)
  const all = Object.keys(intakeQuestions()).flatMap(key => answers[key] === undefined ? [] : [answers[key]])
  const confidence = all.length === 0 ? 0 : all.reduce((sum, answer) => sum + answerConfidence(answer), 0) / all.length
  const code = noul(answers, 'codeSolvable'); const information = noul(answers, 'informationSufficient')
  const value = score(answers, 'value'); const risk = score(answers, 'risk'); const clarity = score(answers, 'scopeClarity')
  const action = choice(answers, 'recommendedAction'); const selectedClass = choice(answers, 'serviceClass')
  const serviceClass = selectedClass === 'express' || selectedClass === 'emergency' ? selectedClass : 'standard'
  const missingInformation: string[] = []
  if (information === undefined || information < policy.informationFloor) missingInformation.push('The evidence is not sufficient for an actionable task.')
  if (clarity === undefined || clarity < 2) missingInformation.push('The desired behavior or scope is not clear enough.')
  const reasons = [`code-solvable ${fmt(code)}`, `information ${fmt(information)}`, `value ${fmt(value)}`, `risk ${fmt(risk)}`, `confidence ${confidence.toFixed(2)}`]
  if (code === undefined || information === undefined || value === undefined || risk === undefined
    || clarity === undefined || action === undefined) {
    return {
      decision: 'manual-review', confidence,
      reasons: [...reasons, 'The provider did not answer every required question.'],
      missingInformation, serviceClass,
    }
  }
  if (action === 'reject' && code < 0.35 && value < 1.5 && confidence >= policy.confidenceFloor) {
    return { decision: 'reject', confidence, reasons, missingInformation, serviceClass }
  }
  if (action === 'ask' || information < 0.45) {
    return { decision: 'needs-information', confidence, reasons, missingInformation, serviceClass }
  }
  if (confidence < policy.confidenceFloor || risk > policy.maximumRisk) {
    return { decision: 'manual-review', confidence, reasons, missingInformation, serviceClass }
  }
  if (code >= policy.codeSolvableFloor && information >= policy.informationFloor && value >= policy.valueFloor
    && (action === 'create' || action === 'investigate')) {
    return { decision: existingCard ? 'continue' : 'propose', confidence, reasons, missingInformation, serviceClass }
  }
  return { decision: 'manual-review', confidence, reasons, missingInformation, serviceClass }
}
function decideStage(answers: Readonly<Record<string, Answer>>, policy: AssessmentPolicy, existingCard: boolean, kind: Exclude<AssessmentKind, 'intake'>): ReturnType<typeof decide> {
  const entries = Object.entries(SPECIALIZED[kind])
  const missing = entries.filter(([key, question]) => answers[key]?.type !== question.type).map(([key]) => key)
  const confidence = Math.min(...entries.map(([key, question]) => {
    const answer = answers[key]
    return answer?.type === question.type ? answerConfidence(answer) : 0
  }))
  const reasons = entries.map(([key, question]) => `${key}: ${question.type === 'choice' ? choice(answers, key) ?? 'unanswered' : fmt(question.type === 'noul' ? noul(answers, key) : score(answers, key))}`)
  const result = (decision: EvaluationDecision, reason: string, missingInformation: string[] = []): ReturnType<typeof decide> => ({ decision, confidence, reasons: [...reasons, reason], missingInformation, serviceClass: 'standard' })
  const yes = (key: string) => (noul(answers, key) ?? 0) >= policy.informationFloor
  const sufficient = (key: string, minimum: number) => (score(answers, key) ?? 0) >= minimum
  const highRisk = (key: string) => (score(answers, key) ?? 0) > policy.maximumRisk
  const evaluate = (): ReturnType<typeof decide> => {
    switch (kind) {
      case 'planning':
        if (!yes('acceptanceExecutable') || !sufficient('dependencyClarity', 2)) return result('needs-information', 'Make acceptance checks executable and clarify dependencies before implementation.', ['Acceptance conditions, dependencies, or failure handling need clarification.'])
        break
      case 'implementation-risk':
        if (highRisk('changeRisk') || !yes('riskControlled')) return result('manual-review', 'Review the affected modules and add concrete controls for implementation risks.')
        break
      case 'test-impact':
        if (!sufficient('testCoverage', 3) || !yes('testEvidenceFresh')) return result('needs-information', 'Add executed tests covering the requested behavior and tie the results to the current changes.', ['Current behavior and regression test evidence is incomplete.'])
        break
      case 'review-scope':
        if (highRisk('reviewBreadth') || !yes('scopeAligned')) return result('manual-review', 'Inspect the affected contracts and reconcile implementation scope with the requirement.')
        break
      case 'release-readiness': {
        const posture = choice(answers, 'releaseDecision')
        if (posture !== 'ready') return result('manual-review', `Release posture is ${posture}; resolve the stated conditions and verify required evidence before release.`)
        if (!yes('requiredEvidencePresent')) return result('needs-information', 'Supply the missing required verification and release evidence.', ['Required tests, validators, or release evidence are missing.'])
        break
      }
      case 'spec-delta':
        if (yes('behaviorChanged') && !yes('specificationCovered')) return result('needs-information', 'Update the requirements or design to describe the changed behavior or contract.', ['The changed behavior is not covered by registered specification evidence.'])
        break
      /* v8 ignore next 2 -- The parser validates AssessmentKind; this branch enforces exhaustiveness at compile time. */
      default:
        return assertNever(kind)
    }
    return result(existingCard ? 'continue' : 'propose', 'The supplied evidence supports continuing this assessment scope; existing gates and validators still apply.')
  }
  const recommendation = evaluate()
  if (missing.length > 0) return result('manual-review', 'The provider did not answer every required stage question.', missing.map(key => `Missing stage answer: ${key}.`))
  if (confidence < policy.confidenceFloor) return result('manual-review', 'The stage evidence does not support a confident recommendation; inspect the evidence before proceeding.')
  return recommendation
}
function fmt(value: number | undefined): string { return value === undefined ? 'unanswered' : value.toFixed(2) }
/* v8 ignore next -- Only the unreachable exhaustive switch branch calls this helper. */
function assertNever(value: never): never { throw new Error(`Unsupported assessment kind: ${String(value)}`) }
