import { describe, expect, it } from 'vitest'
import { readVar, setVar } from '../src/drivers/service/env.ts'

const NAME = 'APP_IMAGE_TAG'

describe('readVar', () => {
  it('reads the declared value', () => {
    expect(readVar('APP_IMAGE_TAG=v1\n', NAME)).toBe('v1')
  })

  it('reads a value among other variables', () => {
    expect(readVar('DB_URL=postgres://x\nAPP_IMAGE_TAG=v2\nPORT=8080\n', NAME)).toBe('v2')
  })

  it('tolerates leading whitespace', () => {
    expect(readVar('  APP_IMAGE_TAG=v3\n', NAME)).toBe('v3')
  })

  it('trims trailing whitespace from the value', () => {
    expect(readVar('APP_IMAGE_TAG=v4   \n', NAME)).toBe('v4')
  })

  it('reports nothing when the variable is absent', () => {
    expect(readVar('PORT=8080\n', NAME)).toBeUndefined()
  })

  it('reports nothing for an empty file', () => {
    expect(readVar('', NAME)).toBeUndefined()
  })

  it('does not match a variable that merely starts the same way', () => {
    expect(readVar('APP_IMAGE_TAG_OLD=v1\n', NAME)).toBeUndefined()
  })

  it('reads an empty assignment as empty', () => {
    expect(readVar('APP_IMAGE_TAG=\n', NAME)).toBe('')
  })
})

describe('setVar', () => {
  it('creates the file contents when there is nothing yet', () => {
    expect(setVar('', NAME, 'v1')).toBe('APP_IMAGE_TAG=v1\n')
  })

  it('replaces the assignment in place and keeps every other line', () => {
    const before = 'DB_URL=postgres://x\nAPP_IMAGE_TAG=v1\n# a comment\nPORT=8080\n'

    const after = setVar(before, NAME, 'v2')

    expect(after).toBe('DB_URL=postgres://x\nAPP_IMAGE_TAG=v2\n# a comment\nPORT=8080\n')
  })

  it('leaves the operator\'s own variables byte-for-byte', () => {
    const before = '# managed by ops\nDB_PASSWORD=hunter2\n\nPORT = 8080\nAPP_IMAGE_TAG=v1\n'

    const after = setVar(before, NAME, 'v2').split('\n')

    expect(after.filter(line => !line.startsWith(NAME)))
      .toEqual(before.split('\n').filter(line => !line.startsWith(NAME)))
  })

  it('appends when the variable is absent', () => {
    expect(setVar('PORT=8080\n', NAME, 'v1')).toBe('PORT=8080\nAPP_IMAGE_TAG=v1\n')
  })

  it('adds the missing newline before appending', () => {
    expect(setVar('PORT=8080', NAME, 'v1')).toBe('PORT=8080\nAPP_IMAGE_TAG=v1\n')
  })

  it('round-trips through readVar', () => {
    expect(readVar(setVar('PORT=8080\n', NAME, 'v9'), NAME)).toBe('v9')
  })

  it('replaces an indented assignment', () => {
    expect(setVar('  APP_IMAGE_TAG=v1\nPORT=1\n', NAME, 'v2')).toBe('APP_IMAGE_TAG=v2\nPORT=1\n')
  })
})
