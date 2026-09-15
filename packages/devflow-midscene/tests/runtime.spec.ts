import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectRun, runAcceptance } from '../src/runner.ts'
import { parseSuite } from '../src/suite.ts'
import { verifyReportSandbox } from './report-sandbox-runtime.ts'
import { startModelFixture } from './support.ts'
import type { RunOptions, Suite } from '../src/types.ts'
const exec = promisify(execFile)
let workspace: string
let output: string
let suiteFile: string
let fixture: Awaited<ReturnType<typeof startModelFixture>>
let options: RunOptions
let suite: Suite
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'midscene-workspace-'))
  output = await mkdtemp(join(tmpdir(), 'midscene-output-'))
  await exec('git', ['init', '-q'], { cwd: workspace })
  await exec(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'],
    { cwd: workspace },
  )
  fixture = await startModelFixture()
  suite = {
    version: 1,
    name: 'Contract',
    baseUrl: fixture.baseUrl,
    buildProbe: { path: '/build', expected: 'fixture-build' },
    cases: [
      {
        id: 'navigation',
        steps: [
          { kind: 'goto', path: '/' },
          { kind: 'text', selector: 'h1', expected: 'Acceptance fixture' },
          { kind: 'assert', prompt: 'Heading is visible' },
        ],
      },
    ],
  }
  suiteFile = join(workspace, 'suite.json')
  await writeFile(suiteFile, JSON.stringify(suite))
  process.env.MIDSCENE_MODEL_BASE_URL = suite.baseUrl + '/v1'
  process.env.MIDSCENE_MODEL_API_KEY = 'fixture-token-secret'
  options = {
    suite: suiteFile,
    workspace,
    output,
    card: '001-fixture',
    buildId: 'fixture-build',
    model: 'gpt-4o',
    timeoutMs: 15000,
    cleanupTimeoutMs: 1000,
    maxSteps: 10,
    ...(process.env.MIDSCENE_TEST_BROWSER ? { executablePath: process.env.MIDSCENE_TEST_BROWSER } : {}),
  }
})
afterEach(async () => {
  await fixture.close()
  delete process.env.MIDSCENE_MODEL_BASE_URL
  delete process.env.MIDSCENE_MODEL_API_KEY
  await rm(workspace, { recursive: true, force: true })
  await rm(output, { recursive: true, force: true })
})
describe('real SDK and Chromium acceptance boundary with a controlled model transport', () => {
  it('persists complete counts, screenshot, real SDK report, and an inspectable pass', async () => {
    const result = await runAcceptance(options)
    expect(result.status).toBe('passed')
    expect(fixture.state.requests).toBeGreaterThan(0)
    expect(result.usage).not.toBe('unavailable')
    expect(result.identity.buildVerified).toBe(true)
    expect(result.counts).toEqual({
      cases: 1,
      completedCases: 1,
      assertions: 2,
      passedAssertions: 2,
      steps: 3,
      completedSteps: 3,
    })
    const dir = join(output, result.runId)
    await verifyReportSandbox(join(dir, 'case-0.html'))
    expect((await readFile(join(dir, 'case-0.html'), 'utf8')).length).toBeGreaterThan(1000)
    expect((await inspectRun(dir)).status).toBe('passed')
    await rm(join(dir, 'report.html'))
    expect((await inspectRun(dir)).status).toBe('infrastructure-error')
  })
  it('distinguishes a real SDK false assertion from wrapped model transport failure', async () => {
    fixture.state.answer = 'false'
    expect((await runAcceptance(options)).status).toBe('assertion-failed')
    fixture.state.answer = 'error'
    const failure = await runAcceptance(options)
    expect(failure.status).toBe('infrastructure-error')
    expect(await readFile(join(output, failure.runId, 'case-0.html'), 'utf8')).not.toContain('fixture-token-secret')
  }, 30000)
  it('fails before visual work when the actual service build differs', async () => {
    suite.buildProbe.expected = 'wrong'
    options.buildId = 'wrong'
    await writeFile(suiteFile, JSON.stringify(suite))
    expect((await runAcceptance(options)).status).toBe('infrastructure-error')
    expect(fixture.state.requests).toBe(0)
  })
  it('cancels and times out actual pending model calls without waiting for SDK completion', async () => {
    fixture.state.answer = 'hang'
    const controller = new AbortController()
    fixture.state.onRequest = () => {
      controller.abort()
    }
    expect((await runAcceptance({ ...options, signal: controller.signal })).status).toBe('cancelled')
    delete fixture.state.onRequest
    expect((await runAcceptance({ ...options, timeoutMs: 2000 })).status).toBe('timed-out')
  }, 30000)
  it('does not start a pre-aborted run and never trusts a nonterminal record', async () => {
    const result = await runAcceptance({ ...options, signal: AbortSignal.abort() })
    expect(result.status).toBe('cancelled')
    expect(fixture.state.requests).toBe(0)
    const dir = join(output, result.runId)
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...result, status: 'running' }))
    expect((await inspectRun(dir)).status).toBe('unknown')
  })
  it('rejects results if workspace content changes while the browser is evaluating', async () => {
    fixture.state.onRequest = () => {
      writeFileSync(join(workspace, 'changed.txt'), 'dirty content')
    }
    const result = await runAcceptance(options)
    expect(result.status).toBe('infrastructure-error')
    expect(result.reason).toBe('Inputs changed during execution')
  })
  it('reports partial completion after a transport failure and preserves stable report links', async () => {
    suite.cases.push({
      id: 'second',
      steps: [
        { kind: 'goto', path: '/' },
        { kind: 'assert', prompt: 'Still visible' },
      ],
    })
    await writeFile(suiteFile, JSON.stringify(suite))
    fixture.state.answer = 'error'
    const result = await runAcceptance({ ...options, reportBaseUrl: 'http://127.0.0.1:8080/reports/' })
    expect(result.status).toBe('infrastructure-error')
    expect(result.counts.completedCases).toBe(1)
    expect(result.counts.cases).toBe(2)
    expect(await readFile(join(output, result.runId, 'test-report.md'), 'utf8')).toContain(
      'http://127.0.0.1:8080/reports/' + result.runId + '/report.html',
    )
  })
  it('preserves deterministic assertion failure even before any visual model call', async () => {
    const first = suite.cases.at(0)
    if (!first) throw new Error('No case')
    first.steps[1] = { kind: 'text', selector: 'h1', expected: 'wrong text' }
    await writeFile(suiteFile, JSON.stringify(suite))
    const result = await runAcceptance(options)
    expect(result.status).toBe('assertion-failed')
    expect(fixture.state.requests).toBe(0)
  })
  it('rejects zero cases, missing visual assertions, foreign navigation, and over-budget input', () => {
    expect(() => parseSuite({ ...suite, cases: [] }, 10)).toThrow()
    expect(() => parseSuite({ ...suite, cases: [{ id: 'empty', steps: [{ kind: 'goto', path: '/' }] }] }, 10)).toThrow()
    expect(() => parseSuite({ ...suite, buildProbe: { path: 'https://other.invalid', expected: 'x' } }, 10)).toThrow()
    expect(() => parseSuite(suite, 1)).toThrow()
  })
})
