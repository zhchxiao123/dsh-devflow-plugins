import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { exploreBrowser, invokeOfficial } from '../src/browser.ts'
import { Config } from '../src/config.ts'
import { verifyReportSandbox } from './report-sandbox-runtime.ts'
import { startModelFixture } from './support.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

it('runs the pinned official CLI against a real isolated browser and preserves false assertions', async () => {
  const fixture = await startModelFixture()
  cleanups.push(fixture.close)
  const root = await mkdtemp(join(tmpdir(), 'official-midscene-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const p = Config({ profiles: { test: {
    workspace: root, output: join(tmpdir(), 'official-results-' + basename(root)),
    targetUrl: fixture.baseUrl, model: 'gpt-4o', family: 'gpt-5', baseUrl: fixture.baseUrl + '/v1', credentialRef: 'TEST_KEY', timeoutMs: 30000,
  } } }).profiles.test!
  cleanups.push(() => rm(p.output, { recursive: true, force: true }))
  const model = { environment: {
    MIDSCENE_MODEL_API_KEY: 'fixture-token-secret', MIDSCENE_MODEL_NAME: 'gpt-4o',
    MIDSCENE_MODEL_BASE_URL: fixture.baseUrl + '/v1', MIDSCENE_MODEL_FAMILY: 'gpt-5',
  }, capability: 'unknown' as const, redact: (s: string) => s.replaceAll('fixture-token-secret', '[REDACTED]') }
  const progress: string[] = []
  const yes = await exploreBrowser(p, { assertion: 'Heading is visible' }, model, new AbortController().signal, line => progress.push(line))
  expect(yes.status, yes.output).toBe('passed')
  expect(yes.cleanup).toBe('confirmed')
  expect(fixture.state.requests).toBeGreaterThan(0)
  expect(progress).toContain('Official Midscene: assert')
  expect(JSON.parse(await readFile(join(yes.directory, 'exploration.json'), 'utf8')) as unknown).toMatchObject({ purpose: 'exploration' })
  const report = yes.artifacts.find(path => path.endsWith('.html'))
  if (!report) throw new Error('Published official report missing')
  await verifyReportSandbox(join(yes.directory, report))
  fixture.state.answer = 'false'
  const no = await exploreBrowser(p, { assertion: 'Deliberately false' }, model, new AbortController().signal, () => {})
  expect(no.status, no.output).toBe('assertion-failed')
  expect(no.cleanup).toBe('confirmed')
  expect(no.runId).not.toBe(yes.runId)
  fixture.state.answer = 'error'
  const error = await exploreBrowser(p, { assertion: 'Transport should fail' }, model, new AbortController().signal, () => {})
  expect(error.status, error.output).toBe('infrastructure-error')
  expect(error.output).not.toContain('fixture-token-secret')
  expect(error.cleanup).toBe('confirmed')
}, 90000)

it('cancels before starting a CLI process', async () => {
  await expect(invokeOfficial(['version'], tmpdir(), {}, AbortSignal.abort(), 1000)).rejects.toThrow()
})
