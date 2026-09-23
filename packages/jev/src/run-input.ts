import { createHash, randomUUID } from 'node:crypto'
import type { JevRunDefinition } from './runs.ts'
import type { JevRunInput } from './run-types.ts'

/** Compiles supplied evidence only; collecting repository or external data belongs to the caller. */
export function genericDefinition(input: JevRunInput): JevRunDefinition {
  if (input.profile !== undefined || input.maxCards !== undefined) throw new Error('dsh-jev: generic runs do not accept profile or maxCards')
  if (input.definitionJson !== undefined) {
    if (input.title !== undefined || input.evidence !== undefined || input.questions !== undefined) throw new Error('dsh-jev: definitionJson cannot be combined with title, evidence, or questions')
    const value: unknown = JSON.parse(input.definitionJson)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('dsh-jev: definitionJson must contain an object')
    // The durable store validates the complete definition before writing it.
    return value as JevRunDefinition
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') throw new Error('dsh-jev: title is required')
  if (typeof input.evidence !== 'string' || input.evidence.trim() === '') throw new Error('dsh-jev: evidence is required; automatic source scanning is not performed')
  if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.some(question => typeof question !== 'string' || question.trim() === '')) throw new Error('dsh-jev: questions must contain at least one non-empty yes/no question')
  const evidence = input.evidence
  const questions: readonly string[] = input.questions
  const id = randomUUID()
  const evidenceDigest = createHash('sha256').update(evidence).digest('hex')
  return {
    id, scope: { kind: 'custom', id, title: input.title.trim() }, template: { id: 'custom-checklist', version: '1' }, createdAt: new Date().toISOString(),
    checks: questions.map((question, index) => ({
      id: `question-${index + 1}`, subject: { kind: 'question', id: `question-${index + 1}`, title: question.trim() }, evidenceDigest,
      request: { state: evidence, questions: { answer: { type: 'noul', instructions: question.trim() } } },
    })),
  }
}
