/**
 * The manifest boundary: every validation rule fires with its field path,
 * every defect of one document is reported at once, and the reserved
 * `kind: 'static'` error stays distinguishable from an unknown value.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadManifest, ManifestError, parseManifest } from '../src/manifest.ts'

const MINIMAL = [
  'services:',
  '  - name: db',
  '    up: run-db',
  '    ready: { tcp: { port: 5432 } }',
  'test: run-tests',
  '',
].join('\n')

/** The minimal manifest with one line swapped in, for single-defect cases. */
function withService(lines: string[]): string {
  return ['services:', ...lines.map(line => `  ${line}`), 'test: run-tests', ''].join('\n')
}

function issuesOf(raw: string): readonly string[] {
  try {
    parseManifest(raw, 'testenv.yml')
  } catch (error) {
    if (error instanceof ManifestError) return error.issues
    throw error
  }
  throw new Error('expected a ManifestError')
}

describe('parseManifest', () => {
  it('accepts and normalizes a minimal manifest', () => {
    expect(parseManifest(MINIMAL, 'testenv.yml')).toEqual({
      services: [{
        name: 'db',
        kind: 'process',
        up: 'run-db',
        ready: { probe: 'tcp', tcp: { host: '127.0.0.1', port: 5432 } },
      }],
      test: 'run-tests',
    })
  })

  it('accepts every optional field and all three probe kinds', () => {
    const raw = [
      'services:',
      '  - name: db',
      '    kind: process',
      '    up: docker compose up -d postgres',
      '    ready: { tcp: { port: 5432, host: db.local } }',
      '    down: docker compose down',
      '    env: { PGPORT: "5432" }',
      '    cwd: services/db',
      '    readyTimeoutMs: 60000',
      '  - name: api',
      '    up: pnpm run start:test',
      '    ready: { http: { url: "http://127.0.0.1:3000/healthz", status: 200 } }',
      '  - name: worker',
      '    up: pnpm run worker',
      '    ready: { command: { run: pg_isready } }',
      'seed: pnpm run db:seed',
      'test: pnpm run test:integration',
      '',
    ].join('\n')
    expect(parseManifest(raw, 'testenv.yml')).toEqual({
      services: [
        {
          name: 'db',
          kind: 'process',
          up: 'docker compose up -d postgres',
          ready: { probe: 'tcp', tcp: { host: 'db.local', port: 5432 } },
          down: 'docker compose down',
          env: { PGPORT: '5432' },
          cwd: 'services/db',
          readyTimeoutMs: 60000,
        },
        {
          name: 'api',
          kind: 'process',
          up: 'pnpm run start:test',
          ready: { probe: 'http', http: { url: 'http://127.0.0.1:3000/healthz', status: 200 } },
        },
        {
          name: 'worker',
          kind: 'process',
          up: 'pnpm run worker',
          ready: { probe: 'command', command: { run: 'pg_isready' } },
        },
      ],
      seed: 'pnpm run db:seed',
      test: 'pnpm run test:integration',
    })
  })

  it('leaves an omitted http status omitted, meaning any 2xx', () => {
    const manifest = parseManifest(withService([
      '- name: api',
      '  up: run-api',
      '  ready: { http: { url: "http://127.0.0.1:3000/healthz" } }',
    ]), 'testenv.yml')
    expect(manifest.services[0]?.ready).toEqual({ probe: 'http', http: { url: 'http://127.0.0.1:3000/healthz' } })
  })

  it.each([
    { label: 'unparseable YAML', raw: 'services: [', issue: 'the manifest is not parseable YAML' },
    { label: 'a sequence root', raw: '- a\n', issue: 'the manifest root must be a YAML mapping' },
    { label: 'an empty document', raw: '', issue: 'the manifest root must be a YAML mapping' },
    { label: 'an unknown top-level key', raw: `${MINIMAL}extra: 1\n`, issue: 'manifest has unknown key "extra"' },
    { label: 'a missing services list', raw: 'test: t\n', issue: 'services must be a list with at least one service' },
    { label: 'a mapping in place of services', raw: 'services: { db: {} }\ntest: t\n', issue: 'services must be a list with at least one service' },
    { label: 'an empty services list', raw: 'services: []\ntest: t\n', issue: 'services must be a list with at least one service' },
    { label: 'a scalar service entry', raw: withService(['- 5']), issue: 'services[0] must be a mapping' },
    {
      label: 'a service with an unknown key',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  portt: 5']),
      issue: 'services[0] has unknown key "portt"',
    },
    {
      label: 'a missing name',
      raw: withService(['- up: u', '  ready: { tcp: { port: 1 } }']),
      issue: 'services[0].name must be a non-empty string',
    },
    {
      label: 'a blank name',
      raw: withService(['- name: " "', '  up: u', '  ready: { tcp: { port: 1 } }']),
      issue: 'services[0].name must be a non-empty string',
    },
    {
      label: 'a duplicate name',
      raw: withService([
        '- name: db', '  up: u', '  ready: { tcp: { port: 1 } }',
        '- name: db', '  up: u', '  ready: { tcp: { port: 2 } }',
      ]),
      issue: 'services[1].name duplicates services[0].name ("db"); service names must be unique',
    },
    {
      label: 'a missing up command',
      raw: withService(['- name: db', '  ready: { tcp: { port: 1 } }']),
      issue: 'services[0].up must be a non-empty string',
    },
    {
      label: 'an unexpected kind',
      raw: withService(['- name: db', '  kind: container', '  up: u', '  ready: { tcp: { port: 1 } }']),
      issue: "services[0].kind must be 'process' when present ('static' is reserved but not implemented)",
    },
    {
      label: 'a missing ready declaration',
      raw: withService(['- name: db', '  up: u']),
      issue: 'services[0].ready is required and must be a mapping declaring exactly one probe: tcp, http, or command',
    },
    {
      label: 'two probes in one ready declaration',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 }, command: { run: r } }']),
      issue: 'services[0].ready must declare exactly one probe: tcp, http, or command',
    },
    {
      label: 'an unknown ready key',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 }, foo: 1 }']),
      issue: 'services[0].ready has unknown key "foo"',
    },
    {
      label: 'a scalar tcp probe',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: 5432 }']),
      issue: 'services[0].ready.tcp must be a mapping with a port and an optional host',
    },
    {
      label: 'a missing tcp port',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { host: h } }']),
      issue: 'services[0].ready.tcp.port must be an integer between 1 and 65535',
    },
    {
      label: 'a fractional tcp port',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1.5 } }']),
      issue: 'services[0].ready.tcp.port must be an integer between 1 and 65535',
    },
    {
      label: 'tcp port 0',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 0 } }']),
      issue: 'services[0].ready.tcp.port must be an integer between 1 and 65535',
    },
    {
      label: 'a tcp port past 65535',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 70000 } }']),
      issue: 'services[0].ready.tcp.port must be an integer between 1 and 65535',
    },
    {
      label: 'a numeric tcp host',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1, host: 5 } }']),
      issue: 'services[0].ready.tcp.host must be a non-empty string when present',
    },
    {
      label: 'an unknown tcp key',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1, portt: 2 } }']),
      issue: 'services[0].ready.tcp has unknown key "portt"',
    },
    {
      label: 'a scalar http probe',
      raw: withService(['- name: api', '  up: u', '  ready: { http: "http://x" }']),
      issue: 'services[0].ready.http must be a mapping with a url and an optional status',
    },
    {
      label: 'a missing http url',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { status: 200 } }']),
      issue: 'services[0].ready.http.url must be an absolute http:// URL (https readiness probing is not supported)',
    },
    {
      label: 'a relative http url',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: "/healthz" } }']),
      issue: 'services[0].ready.http.url must be an absolute http:// URL (https readiness probing is not supported)',
    },
    {
      label: 'an https url',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: "https://127.0.0.1/healthz" } }']),
      issue: 'services[0].ready.http.url must be an absolute http:// URL (https readiness probing is not supported)',
    },
    {
      label: 'a numeric http url',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: 5 } }']),
      issue: 'services[0].ready.http.url must be an absolute http:// URL (https readiness probing is not supported)',
    },
    {
      label: 'a string http status',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: "http://x/", status: ok } }']),
      issue: 'services[0].ready.http.status must be an integer HTTP status between 100 and 599',
    },
    {
      label: 'a fractional http status',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: "http://x/", status: 200.5 } }']),
      issue: 'services[0].ready.http.status must be an integer HTTP status between 100 and 599',
    },
    {
      label: 'http status 99',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: "http://x/", status: 99 } }']),
      issue: 'services[0].ready.http.status must be an integer HTTP status between 100 and 599',
    },
    {
      label: 'http status 600',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: "http://x/", status: 600 } }']),
      issue: 'services[0].ready.http.status must be an integer HTTP status between 100 and 599',
    },
    {
      label: 'an unknown http key',
      raw: withService(['- name: api', '  up: u', '  ready: { http: { url: "http://x/", body: b } }']),
      issue: 'services[0].ready.http has unknown key "body"',
    },
    {
      label: 'a scalar command probe',
      raw: withService(['- name: db', '  up: u', '  ready: { command: pg_isready }']),
      issue: 'services[0].ready.command must be a mapping with a run command',
    },
    {
      label: 'a missing command run',
      raw: withService(['- name: db', '  up: u', '  ready: { command: {} }']),
      issue: 'services[0].ready.command.run must be a non-empty string',
    },
    {
      label: 'a blank command run',
      raw: withService(['- name: db', '  up: u', '  ready: { command: { run: " " } }']),
      issue: 'services[0].ready.command.run must be a non-empty string',
    },
    {
      label: 'an unknown command key',
      raw: withService(['- name: db', '  up: u', '  ready: { command: { run: r, shell: bash } }']),
      issue: 'services[0].ready.command has unknown key "shell"',
    },
    {
      label: 'a numeric down command',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  down: 5']),
      issue: 'services[0].down must be a non-empty string',
    },
    {
      label: 'a scalar env block',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  env: production']),
      issue: 'services[0].env must be a mapping of variable names to string values',
    },
    {
      label: 'a numeric env value',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  env: { PGPORT: 5432 }']),
      issue: 'services[0].env.PGPORT must be a string',
    },
    {
      label: 'a blank cwd',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  cwd: ""']),
      issue: 'services[0].cwd must be a non-empty string',
    },
    {
      label: 'a zero readyTimeoutMs',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  readyTimeoutMs: 0']),
      issue: 'services[0].readyTimeoutMs must be a positive integer of milliseconds',
    },
    {
      label: 'a fractional readyTimeoutMs',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  readyTimeoutMs: 10.5']),
      issue: 'services[0].readyTimeoutMs must be a positive integer of milliseconds',
    },
    {
      label: 'a string readyTimeoutMs',
      raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }', '  readyTimeoutMs: fast']),
      issue: 'services[0].readyTimeoutMs must be a positive integer of milliseconds',
    },
    { label: 'a missing test command', raw: withService(['- name: db', '  up: u', '  ready: { tcp: { port: 1 } }']).replace('test: run-tests\n', ''), issue: 'test must be a non-empty string' },
    { label: 'a numeric seed command', raw: `${MINIMAL}seed: 5\n`, issue: 'seed must be a non-empty string' },
  ])('rejects $label', ({ raw, issue }) => {
    expect(issuesOf(raw).join('\n')).toContain(issue)
  })

  it("rejects the reserved kind 'static' with its own not-implemented error", () => {
    const issues = issuesOf(withService(['- name: web', '  kind: static', '  up: u', '  ready: { tcp: { port: 1 } }']))
    expect(issues).toContain(
      "services[0].kind: 'static' services are reserved for future static preview hosting and are not implemented yet; run the service as a 'process' or remove it",
    )
    // Reserved is not unknown: the two errors must stay distinguishable.
    expect(issues.join('\n')).not.toContain("must be 'process' when present")
  })

  it('normalizes a single evidence glob into a list', () => {
    const raw = [MINIMAL.trimEnd(), 'evidence: test-results/**', ''].join('\n')
    expect(parseManifest(raw, 'testenv.yml').evidence).toEqual(['test-results/**'])
  })

  it('keeps a list of evidence globs in declaration order', () => {
    const raw = [MINIMAL.trimEnd(), 'evidence:', '  - test-results/**', '  - playwright-report/**', ''].join('\n')
    expect(parseManifest(raw, 'testenv.yml').evidence).toEqual(['test-results/**', 'playwright-report/**'])
  })

  it('accepts a report declaration and carries its parser tag', () => {
    const raw = [MINIMAL.trimEnd(), 'report:', '  path: test-results/report.json', '  format: playwright-json', ''].join('\n')
    expect(parseManifest(raw, 'testenv.yml').report).toEqual({
      path: 'test-results/report.json',
      format: 'playwright-json',
    })
  })

  it('leaves both evidence and report absent when neither is declared', () => {
    const manifest = parseManifest(MINIMAL, 'testenv.yml')
    expect(manifest.evidence).toBeUndefined()
    expect(manifest.report).toBeUndefined()
  })

  it('rejects an evidence path that escapes the workspace root', () => {
    for (const escape of ['/etc/passwd', '../outside/**', 'a/../../b']) {
      expect(issuesOf([MINIMAL.trimEnd(), `evidence: ${escape}`, ''].join('\n'))).toContain(
        "evidence must stay inside the workspace root (no absolute paths, no '..' segments)",
      )
    }
  })

  it('names the offending entry when one glob of a list escapes', () => {
    const raw = [MINIMAL.trimEnd(), 'evidence:', '  - test-results/**', '  - ../outside/**', ''].join('\n')
    expect(issuesOf(raw)).toContain(
      "evidence[1] must stay inside the workspace root (no absolute paths, no '..' segments)",
    )
  })

  it('rejects an evidence value that is neither a glob nor a list of them', () => {
    expect(issuesOf([MINIMAL.trimEnd(), 'evidence: 5', ''].join('\n'))).toContain(
      'evidence must be a glob string, or a list of at least one glob',
    )
  })

  it('rejects a blank report path', () => {
    expect(issuesOf([MINIMAL.trimEnd(), 'report: { path: "  ", format: playwright-json }', ''].join('\n'))).toContain(
      'report.path must be a non-empty string',
    )
  })

  it('drops an evidence list whose every entry is a defect, leaving the defects reported', () => {
    const issues = issuesOf([MINIMAL.trimEnd(), 'evidence:', '  - ""', '  - /abs', ''].join('\n'))
    expect(issues).toEqual([
      'evidence[0] must be a non-empty string',
      "evidence[1] must stay inside the workspace root (no absolute paths, no '..' segments)",
    ])
  })

  it('rejects an empty evidence list', () => {
    const raw = [MINIMAL.trimEnd(), 'evidence: []', ''].join('\n')
    expect(issuesOf(raw)).toContain('evidence must be a glob string, or a list of at least one glob')
  })

  it('rejects an unknown report format by listing every legal one', () => {
    const raw = [MINIMAL.trimEnd(), 'report:', '  path: r.xml', '  format: teamcity', ''].join('\n')
    expect(issuesOf(raw)).toContain('report.format must be one of: "playwright-json"')
  })

  it('reports a report declaration\'s own defects with their field paths', () => {
    const raw = [MINIMAL.trimEnd(), 'report:', '  path: /tmp/r.json', '  extra: 1', ''].join('\n')
    expect(issuesOf(raw)).toEqual([
      'report has unknown key "extra"',
      "report.path must stay inside the workspace root (no absolute paths, no '..' segments)",
      'report.format must be one of: "playwright-json"',
    ])
  })

  it('rejects a report that is not a mapping', () => {
    const raw = [MINIMAL.trimEnd(), 'report: test-results/report.json', ''].join('\n')
    expect(issuesOf(raw)).toContain('report must be a mapping with a path and a format')
  })

  it('reports every defect of one document at once, each with its field path', () => {
    const issues = issuesOf([
      'services:',
      '  - name: db',
      '    ready: { tcp: { port: 0 } }',
      '  - 5',
      'extra: 1',
      '',
    ].join('\n'))
    expect(issues).toEqual([
      'manifest has unknown key "extra"',
      'services[0].up must be a non-empty string',
      'services[0].ready.tcp.port must be an integer between 1 and 65535',
      'services[1] must be a mapping',
      'test must be a non-empty string',
    ])
  })

  it('throws a ManifestError naming the path and listing one line per issue', () => {
    let caught: unknown
    try {
      parseManifest('- a\n', 'sub/dir/testenv.yml')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ManifestError)
    const manifestError = caught as ManifestError
    expect(manifestError.name).toBe('ManifestError')
    expect(manifestError.message).toBe('testenv manifest sub/dir/testenv.yml is invalid:\n- the manifest root must be a YAML mapping')
  })
})

describe('loadManifest', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('reads and validates a manifest file', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-testenv-manifest-'))
    const path = join(root, 'testenv.yml')
    await writeFile(path, MINIMAL)
    const manifest = await loadManifest(path)
    expect(manifest.services.map(service => service.name)).toEqual(['db'])
  })

  it('reports an unreadable manifest file as a ManifestError', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-testenv-manifest-'))
    const path = join(root, 'missing.yml')
    await expect(loadManifest(path)).rejects.toThrow('the manifest file cannot be read')
    await expect(loadManifest(path)).rejects.toBeInstanceOf(ManifestError)
  })
})
