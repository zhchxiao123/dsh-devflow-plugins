import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { genericDefinition } from '../src/run-input.ts'

describe('generic checklist input', () => {
  it('makes independent durable yes/no checks from supplied evidence without inspecting a source', () => {
    const input = { title: '  Release evidence  ', evidence: 'Test report: 8 passed', questions: ['  Did tests pass? ', 'Is the report current?'] }
    const result = genericDefinition(input)
    expect(result.scope).toEqual({ kind: 'custom', id: result.id, title: 'Release evidence' })
    expect(result.template).toEqual({ id: 'custom-checklist', version: '1' })
    expect(result.checks.map(check => check.id)).toEqual(['question-1', 'question-2'])
    expect(result.checks[0]).toMatchObject({ subject: { title: 'Did tests pass?' }, evidenceDigest: createHash('sha256').update(input.evidence).digest('hex'), request: { state: input.evidence, questions: { answer: { type: 'noul', instructions: 'Did tests pass?' } } } })
    expect(genericDefinition(input).id).not.toBe(result.id)
  })

  it.each([
    [{ profile: 'full' }, 'profile or maxCards'], [{ maxCards: 3 }, 'profile or maxCards'],
    [{ definitionJson: '{}', title: 'x' }, 'cannot be combined'], [{ definitionJson: '{}', evidence: 'x' }, 'cannot be combined'], [{ definitionJson: '{}', questions: [] }, 'cannot be combined'],
    [{ definitionJson: 'null' }, 'object'], [{ definitionJson: '[]' }, 'object'], [{ definitionJson: '1' }, 'object'],
    [{}, 'title is required'], [{ title: ' ' }, 'title is required'], [{ title: 'x' }, 'evidence is required'], [{ title: 'x', evidence: ' ' }, 'evidence is required'],
    [{ title: 'x', evidence: 'e' }, 'questions must contain'], [{ title: 'x', evidence: 'e', questions: [] }, 'questions must contain'], [{ title: 'x', evidence: 'e', questions: [' '] }, 'questions must contain'],
  ])('rejects contradictory or incomplete input %j', (input, message) => { expect(() => genericDefinition(input)).toThrow(message) })

  it('passes advanced definitions to the durable store for complete validation', () => {
    expect(genericDefinition({ definitionJson: '{"id":"advanced"}' })).toEqual({ id: 'advanced' })
    expect(() => genericDefinition({ definitionJson: '{broken' })).toThrow()
  })
})
