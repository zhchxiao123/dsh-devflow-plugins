// Quoting is the boundary that keeps a configured path or a target name from
// becoming a command. A real shell decides whether it held — a regex over the
// command string would only be a guess about what sh does with it.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { quote, remoteArgv, remoteJoin, sshPreflightArgv } from '../src/shell.ts'

function expandedBySh(value: string): string {
  return execFileSync('sh', ['-c', `printf %s ${quote(value)}`], { encoding: 'utf8' })
}

describe('quote', () => {
  it('suspends every expansion', () => {
    expect(quote('/srv/www')).toBe('\'/srv/www\'')
    expect(quote('a b')).toBe('\'a b\'')
    expect(quote('$HOME')).toBe('\'$HOME\'')
    expect(quote('`id`')).toBe('\'`id`\'')
    expect(quote('a;rm -rf /')).toBe('\'a;rm -rf /\'')
  })

  it('closes, escapes, and reopens an embedded single quote', () => {
    expect(quote('it\'s')).toBe('\'it\'\\\'\'s\'')
  })

  it.each([
    ['a command separator', 'a; rm -rf /'],
    ['a substitution', '$(id)'],
    ['a backtick', '`id`'],
    ['a quote break-out', 'a\'; rm -rf /; \''],
    ['a path escape', '../../etc'],
    ['a newline', 'a\nb'],
    ['a space', 'my releases'],
    ['a backslash', 'a\\b'],
    ['an env-file line', 'APP_IMAGE_TAG=v1\nOTHER=2\n'],
  ])('passes %s through as one literal argument', (_label, value) => {
    expect(expandedBySh(value)).toBe(value)
  })
})

describe('remoteJoin', () => {
  it('collapses separators between segments', () => {
    expect(remoteJoin('/srv/releases/', '/landing/', 'v1')).toBe('/srv/releases/landing/v1')
  })

  it('drops empty segments', () => {
    expect(remoteJoin('/srv', '', 'landing')).toBe('/srv/landing')
  })

  it('keeps a leading slash on the first segment', () => {
    expect(remoteJoin('/srv')).toBe('/srv')
  })
})

describe('remoteArgv', () => {
  it('never prompts for a key', () => {
    expect(remoteArgv('deploy@example.test', 'true'))
      .toEqual(['ssh', '-o', 'BatchMode=yes', 'deploy@example.test', 'true'])
    expect(sshPreflightArgv('deploy@example.test')).toEqual(remoteArgv('deploy@example.test', 'true'))
  })
})
