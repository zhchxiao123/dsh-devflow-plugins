import type { Answer, JevRequest } from '@zhchxiao123/dsh-jev'
import type { AssessmentKind, AssessmentPolicy, EvaluationDecision } from './types.ts'

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
} as const
export function assessmentRequest(state: Readonly<Record<string, string>>, kind: AssessmentKind): JevRequest {
  return { state: { task: `Devflow ${kind} assessment`, ...state }, questions: {
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
  } }
}
function noul(answers: Readonly<Record<string, Answer>>, key: string): number | undefined { const answer = answers[key]; return answer?.type === 'noul' ? answer.noul : undefined }
function score(answers: Readonly<Record<string, Answer>>, key: string): number | undefined { const answer = answers[key]; return answer?.type === 'score' ? answer.score : undefined }
function choice(answers: Readonly<Record<string, Answer>>, key: string): string | undefined { const answer = answers[key]; return answer?.type === 'choice' ? answer.choice : undefined }
function answerConfidence(answer: Answer): number { return answer.type === 'noul' ? Math.abs(answer.noul - 0.5) * 2 : answer.confidence }
export function decide(answers: Readonly<Record<string, Answer>>, policy: AssessmentPolicy, existingCard: boolean): { decision: EvaluationDecision; confidence: number; reasons: string[]; missingInformation: string[]; serviceClass: 'standard' | 'express' | 'emergency' } {
  const all = Object.values(answers)
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
function fmt(value: number | undefined): string { return value === undefined ? 'unanswered' : value.toFixed(2) }
