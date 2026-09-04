import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  flipArgv,
  listReleasesArgv,
  makeReleaseDirArgv,
  pruneArgv,
  quote,
  readCurrentArgv,
  releaseDir,
  remoteJoin,
  rsyncArgv,
  servedLink,
  sshPreflightArgv,
  targetUrl,
} from '../src/drivers/static/remote.ts'

const HOST = 'deploy@example.com'
const WEB = '/srv/www'
const RELEASES = '/srv/releases'
const ID = '20260903T194507Z'

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

describe('the remote layout', () => {
  it('keeps release payloads outside the served tree', () => {
    expect(releaseDir(RELEASES, 'landing', ID)).toBe('/srv/releases/landing/20260903T194507Z')
    expect(servedLink(WEB, 'landing')).toBe('/srv/www/landing')
  })

  it('addresses a target below the base URL', () => {
    expect(targetUrl('https://example.com', 'landing')).toBe('https://example.com/landing/')
    expect(targetUrl('https://example.com/', 'landing')).toBe('https://example.com/landing/')
  })
})

describe('remote commands', () => {
  it('proves the host answers without prompting for a key', () => {
    expect(sshPreflightArgv(HOST)).toEqual(['ssh', '-o', 'BatchMode=yes', HOST, 'true'])
  })

  it('creates the release directory before the transfer', () => {
    expect(makeReleaseDirArgv(HOST, RELEASES, 'landing', ID)).toEqual([
      'ssh', '-o', 'BatchMode=yes', HOST,
      'mkdir -p \'/srv/releases/landing/20260903T194507Z\'',
    ])
  })

  it('transfers into a fresh directory and never passes --delete', () => {
    const argv = rsyncArgv('/ws/dist', HOST, RELEASES, 'landing', ID)

    expect(argv).toEqual([
      'rsync', '-az',
      '/ws/dist/',
      'deploy@example.com:/srv/releases/landing/20260903T194507Z/',
    ])
    expect(argv).not.toContain('--delete')
  })

  it('normalises a trailing slash on the local directory', () => {
    expect(rsyncArgv('/ws/dist/', HOST, RELEASES, 'landing', ID)[2]).toBe('/ws/dist/')
  })

  it('stages the symlink and renames it over the live one', () => {
    expect(flipArgv(HOST, WEB, RELEASES, 'landing', ID)[4]).toBe(
      'ln -sfn \'/srv/releases/landing/20260903T194507Z\' \'/srv/www/landing.tmp.20260903T194507Z\' '
      + '&& mv -T \'/srv/www/landing.tmp.20260903T194507Z\' \'/srv/www/landing\'',
    )
  })

  it('lists releases without failing when the target has none yet', () => {
    expect(listReleasesArgv(HOST, RELEASES, 'landing')[4])
      .toBe('ls -1 \'/srv/releases/landing\' 2>/dev/null || true')
  })

  it('reads the served symlink without failing when nothing is deployed', () => {
    expect(readCurrentArgv(HOST, WEB, 'landing')[4])
      .toBe('readlink \'/srv/www/landing\' 2>/dev/null || true')
  })

  it('removes every superseded payload in one command', () => {
    expect(pruneArgv(HOST, RELEASES, 'landing', ['a', 'b'])[4])
      .toBe('rm -rf \'/srv/releases/landing/a\' \'/srv/releases/landing/b\'')
  })
})

describe('defence in depth against a hostile identifier', () => {
  // The manifest already rejects these names; the quoting must hold anyway,
  // because a driver is one refactor away from a value the core did not vet.
  // A real shell decides whether it held — a regex over the command string
  // would only be a guess about what sh does with it.
  function expandedBySh(value: string): string {
    return execFileSync('sh', ['-c', `printf %s ${quote(value)}`], { encoding: 'utf8' })
  }

  it.each([
    ['a command separator', 'a; rm -rf /'],
    ['a substitution', '$(id)'],
    ['a backtick', '`id`'],
    ['a quote break-out', 'a\'; rm -rf /; \''],
    ['a path escape', '../../etc'],
    ['a newline', 'a\nb'],
    ['a space', 'my releases'],
    ['a backslash', 'a\\b'],
  ])('passes %s through as one literal argument', (_label, value) => {
    expect(expandedBySh(value)).toBe(value)
  })

  it('keeps a hostile target name inside the quoted path of every command', () => {
    const hostile = '$(id)'

    expect(flipArgv(HOST, WEB, RELEASES, hostile, ID)[4])
      .toContain('\'/srv/releases/$(id)/20260903T194507Z\'')
    expect(expandedBySh(`/srv/releases/${hostile}`)).toBe('/srv/releases/$(id)')
  })

  it('quotes a path containing spaces as one argument', () => {
    expect(makeReleaseDirArgv(HOST, '/srv/my releases', 'landing', ID)[4])
      .toBe('mkdir -p \'/srv/my releases/landing/20260903T194507Z\'')
  })
})
