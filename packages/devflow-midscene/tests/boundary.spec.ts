import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { inspectRun, runAcceptance } from '../src/runner.ts'
import { parseSuite } from '../src/suite.ts'
import { workspaceIdentity, within } from '../src/identity.ts'
import type { RunOptions, Suite } from '../src/types.ts'
const exec = promisify(execFile)
let workspace: string
let output: string
let suite: Suite
let options: RunOptions
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'midscene-boundary-'))
  output = await mkdtemp(join(tmpdir(), 'midscene-boundary-output-'))
  await exec('git', ['init', '-q'], { cwd: workspace })
  await exec(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'],
    { cwd: workspace },
  )
  suite = {
    version: 1,
    name: 'suite',
    baseUrl: 'http://127.0.0.1:1',
    buildProbe: { path: '/build', expected: 'build' },
    cases: [{ id: 'case', steps: [{ kind: 'assert', prompt: 'Visible' }] }],
  }
  const path = join(workspace, 'suite.json')
  await writeFile(path, JSON.stringify(suite))
  options = {
    suite: path,
    workspace,
    output,
    card: '001-card',
    buildId: 'build',
    model: 'gpt-4o',
    maxSteps: 20,
    timeoutMs: 1000,
    cleanupTimeoutMs: 200,
    signal: AbortSignal.abort(),
  }
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(output, { recursive: true, force: true })
})

it('validates complete suite content before any browser work', () => {
  for (const invalid of [
    null,
    1,
    [],
    {},
    { ...suite, version: 2 },
    { ...suite, cases: null },
    { ...suite, name: '' },
    { ...suite, name: 'x'.repeat(16385) },
    { ...suite, baseUrl: 'file:///etc/passwd' },
    { ...suite, baseUrl: 'http://user:password@host/' },
    { ...suite, baseUrl: 'http://host/?token=x' },
    { ...suite, buildProbe: null },
    { ...suite, cases: [{ id: 'x', steps: null }] },
    { ...suite, cases: [{ id: 'x', steps: [] }] },
    { ...suite, cases: [{ id: 'x', steps: [{ kind: 'unknown' }] }] },
    { ...suite, cases: [...suite.cases, ...suite.cases] },
  ])
    expect(() => parseSuite(invalid, 20)).toThrow()
  const complete = {
    ...suite,
    cases: [
      {
        id: 'all',
        steps: [
          { kind: 'goto', path: '/' },
          { kind: 'act', prompt: 'Click' },
          { kind: 'text', selector: 'h1', expected: 'Heading' },
          { kind: 'assert', prompt: 'Visible' },
        ],
      },
    ],
  }
  expect(parseSuite(complete, 20).cases).toHaveLength(1)
})

it('rejects invalid limits, identities, build requests and unsafe output before creating directories', async () => {
  for (const invalid of [
    { timeoutMs: 0 },
    { maxSteps: 1.5 },
    { cleanupTimeoutMs: -1 },
    { card: '' },
    { model: 'a\nb' },
    { buildId: 'other' },
    { output: join(workspace, 'must-not-create') },
  ])
    await expect(runAcceptance({ ...options, ...invalid })).rejects.toThrow()
  await expect(readFile(join(workspace, 'must-not-create', 'manifest.json'))).rejects.toThrow()
  await expect(runAcceptance({ ...options, reportBaseUrl: 'https://user:password@host/' })).rejects.toThrow()
  const link = join(output, 'workspace-link')
  await symlink(workspace, link, 'junction')
  await expect(runAcceptance({ ...options, output: join(link, 'must-not-create') })).rejects.toThrow()
})

it('fingerprints untracked, tracked, deleted and symlink content and ignores output outside the root', async () => {
  const baseline = await workspaceIdentity(workspace)
  await writeFile(join(workspace, 'file'), 'one')
  const untracked = await workspaceIdentity(workspace)
  expect(untracked.workspaceSha256).not.toBe(baseline.workspaceSha256)
  await exec('git', ['add', 'file'], { cwd: workspace })
  expect((await workspaceIdentity(workspace)).workspaceSha256).toBe(untracked.workspaceSha256)
  await chmod(join(workspace, 'file'), 0o755)
  if (process.platform !== 'win32')
    expect((await workspaceIdentity(workspace)).workspaceSha256).not.toBe(untracked.workspaceSha256)
  await rm(join(workspace, 'file'))
  expect((await workspaceIdentity(workspace)).workspaceSha256).not.toBe(untracked.workspaceSha256)
  await symlink(join(workspace, 'suite.json'), join(workspace, 'link'))
  expect((await workspaceIdentity(workspace)).workspaceSha256).not.toBe(baseline.workspaceSha256)
  await mkdir(join(workspace, 'nested'))
  await expect(workspaceIdentity(join(workspace, 'nested'))).rejects.toThrow('Git root')
  expect(within(workspace, workspace)).toBe(true)
  expect(within(workspace, join(workspace, 'child'))).toBe(true)
  expect(within(workspace, output)).toBe(false)
})

it('refuses malformed durable records and incomplete or missing report evidence', async () => {
  const cancelled = await runAcceptance(options)
  const dir = join(output, cancelled.runId)
  const manifest = join(dir, 'manifest.json')
  for (const value of [
    null,
    {},
    { ...cancelled, counts: {} },
    { ...cancelled, results: [{}] },
    {
      ...cancelled,
      results: [{ id: 'x', status: 'passed', completedSteps: 0, passedAssertions: 0, report: '../escape' }],
    },
  ]) {
    await writeFile(manifest, JSON.stringify(value))
    await expect(inspectRun(dir)).rejects.toThrow()
  }
  await writeFile(manifest, JSON.stringify({ ...cancelled, status: 'passed' }))
  expect((await inspectRun(dir)).status).toBe('infrastructure-error')
  await writeFile(manifest, JSON.stringify(cancelled))
  expect((await inspectRun(dir)).status).toBe('cancelled')
})

it('decodes authenticated JSON probe fields and rejects ambiguous or malformed protocols', () => {
  const probe = { path: '/build', expected: 'build', format: 'json', method: 'POST', field: ['value', 'buildId'], instanceField: ['value', 'instanceId'] }
  expect(parseSuite({ ...suite, buildProbe: probe }, 10).buildProbe).toEqual(probe)
  for (const invalid of [{ ...probe, method: 'DELETE' }, { ...probe, format: 'xml' }, { ...probe, field: [] }, { ...probe, field: 'id' }, { ...probe, field: Array(9).fill('a') }, { ...probe, field: undefined }, { ...probe, format: 'text' }, { path: '/build', expected: 'build', instanceField: ['id'] }]) expect(() => parseSuite({ ...suite, buildProbe: invalid }, 10)).toThrow()
})

it('rejects assertion-free and cross-origin suites before browser startup', () => {
  expect(() => parseSuite({ ...suite, cases: [{ id: 'case', steps: [{ kind: 'goto', path: '/' }] }] }, 10)).toThrow('visual assertions')
  expect(() => parseSuite({ ...suite, buildProbe: { path: 'https://other.invalid/build', expected: 'build' } }, 10)).toThrow('declared origin')
})

it('refuses suite files and aliases into root Devflow runtime state', async () => {
  await mkdir(join(workspace, '.devflow'))
  const path = join(workspace, '.devflow', 'suite.json')
  await writeFile(path, JSON.stringify(suite))
  await expect(runAcceptance({ ...options, suite: path })).rejects.toThrow('Suite must be outside')
  const alias = join(workspace, 'suite-alias.json')
  await symlink(path, alias)
  await expect(runAcceptance({ ...options, suite: alias })).rejects.toThrow('Suite must be outside')
})

it('accepts generated project suites with a separate suite hash and refuses aliases into that directory', async () => {
  const directory = join(workspace, '.devflow', 'midscene', 'suites')
  await mkdir(directory, { recursive: true })
  const path = join(directory, '0001-task.json')
  await writeFile(path, JSON.stringify(suite))
  const result = await runAcceptance({ ...options, suite: path })
  expect(result.status).toBe('cancelled')
  expect(result.identity.suiteSha256).toHaveLength(64)
  const alias = join(workspace, 'generated-alias.json')
  await symlink(path, alias)
  await expect(runAcceptance({ ...options, suite: alias })).rejects.toThrow('direct file')
})
