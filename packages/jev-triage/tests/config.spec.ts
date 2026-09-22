// Configuration is checked at load. A rubric or a threshold that only fails
// when something first needs triaging is a failure nobody sees until it counts.
import { describe, expect, it } from 'vitest'
import { Config, assertConfig } from '@zhchxiao123/dsh-jev-triage'
import type { ResolvedConfig } from '@zhchxiao123/dsh-jev-triage'

const VALID = Config({}) as ResolvedConfig

describe('assertConfig', () => {
  it('accepts a fully defaulted configuration', () => {
    expect(() => { assertConfig(VALID) }).not.toThrow()
  })

  it.each([
    ['a non-object', null, 'config must be an object'],
    ['a one-level rubric', { ...VALID, scoreLevels: ['only'] }, 'at least two levels'],
    ['a rubric that is not an array', { ...VALID, scoreLevels: 'Trivial' }, 'at least two levels'],
    ['an empty level', { ...VALID, scoreLevels: ['a', ''] }, 'non-empty description'],
    ['a non-string level', { ...VALID, scoreLevels: ['a', 7] }, 'non-empty description'],
    ['an empty instruction', { ...VALID, scoreInstruction: '' }, 'config.scoreInstruction'],
    ['a skip line past the ceiling', { ...VALID, skipBelow: 99 }, 'config.skipBelow'],
    ['a negative skip line', { ...VALID, skipBelow: -1 }, 'config.skipBelow'],
    ['a confidence floor above one', { ...VALID, confidenceFloor: 1.5 }, 'config.confidenceFloor'],
    ['a negative confidence floor', { ...VALID, confidenceFloor: -0.1 }, 'config.confidenceFloor'],
    ['a zero batch size', { ...VALID, maxFiles: 0 }, 'config.maxFiles'],
    ['a fractional file budget', { ...VALID, maxFileChars: 1.5 }, 'config.maxFileChars'],
    ['a zero call budget', { ...VALID, maxTotalChars: 0 }, 'config.maxTotalChars'],
    ['a zero capture budget', { ...VALID, stdoutMaxBytes: 0 }, 'config.stdoutMaxBytes'],
    ['a zero deadline', { ...VALID, timeoutMs: 0 }, 'config.timeoutMs'],
  ])('rejects %s', (_label, config, message) => {
    expect(() => { assertConfig(config) }).toThrow(message)
  })

  it('accepts a skip line of zero, which is how triage is turned off without unmounting it', () => {
    expect(() => { assertConfig({ ...VALID, skipBelow: 0 }) }).not.toThrow()
  })
})
