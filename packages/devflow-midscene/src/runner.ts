/** Runs one user-invoked acceptance suite in an isolated child process. Harness owns workflow and job policy. */
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve, relative, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sha256, within, workspaceIdentity } from './identity.ts'
import { finalizeReports, writeManifest } from './reports.ts'
import { parseSuite } from './suite.ts'
import { publicationAvailable } from './publication.ts'
import { terminateOwnedTree } from './process-tree.ts'
import { parseStorageState, readPrivateJson } from './auth-state.ts'
import { verifyDeploymentRecord } from './deployment.ts'
import { retainRecheckSnapshot } from './recheck.ts'
import { assertSuiteLocation } from './suite-location.ts'
export { recheckAcceptance } from './recheck.ts'
import { childEnvironment } from './environment.ts'
import type { CaseResult, RunManifest, RunOptions, WorkerInput } from './types.ts'
export type { RunManifest, RunOptions, Suite } from './types.ts'

function reportBase(runDir: string, base: string | undefined, runId: string): string {
  if (base === undefined) return pathToFileURL(runDir + '/').href
  const url = new URL(base.endsWith('/') ? base : base + '/')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Report base must be an HTTP URL without credentials')
  return new URL(runId + '/', url).href
}
function caseResult(value: unknown): CaseResult | undefined {
  if (!value || typeof value !== 'object') return
  const v = value as Record<string, unknown>
  if (
    typeof v.id !== 'string' ||
    typeof v.status !== 'string' ||
    !['passed', 'assertion-failed', 'infrastructure-error'].includes(v.status) ||
    !Number.isSafeInteger(v.completedSteps) ||
    !Number.isSafeInteger(v.passedAssertions)
  )
    return
  for (const field of ['report', 'screenshot'])
    if (v[field] !== undefined && (typeof v[field] !== 'string' || !/^case-\d+\.(html|png)$/.test(v[field]))) return
  return v as unknown as CaseResult
}
/** Execute fresh browser work and return only after worker exit and final report persistence. */
export async function runAcceptance(options: RunOptions): Promise<RunManifest> {
  for (const value of [options.timeoutMs, options.maxSteps, options.cleanupTimeoutMs])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Limits must be positive integers')
  for (const value of [options.card, options.buildId, options.model])
    if (!value.trim() || /[\r\n]/.test(value)) throw new Error('Identity fields must be nonempty single lines')
  const environment = childEnvironment(options.environment)
  for (const key of ['MIDSCENE_INSIGHT_MODEL_NAME', 'MIDSCENE_PLANNING_MODEL_NAME']) {
    if (environment[key] && environment[key] !== options.model)
      throw new Error('Role-specific model conflicts with recorded model')
  }
  const deadline = Date.now() + options.timeoutMs
  const workspace = await realpath(options.workspace)
  assertSuiteLocation(workspace, await realpath(resolve(options.suite)), options.workspace, options.suite)
  const source = await readFile(resolve(options.suite))
  const suite = parseSuite(JSON.parse(source.toString('utf8')) as unknown, options.maxSteps)
  if (suite.buildProbe.expected !== options.buildId) throw new Error('Build probe must match requested build identity')
  let ancestor = resolve(options.output)
  let canonical: string | undefined
  while (canonical === undefined) {
    try {
      canonical = await realpath(ancestor)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      ancestor = dirname(ancestor)
    }
  }
  if (within(workspace, resolve(canonical, relative(ancestor, resolve(options.output))))) {
    throw new Error('Output must be outside the fingerprinted workspace')
  }
  await mkdir(options.output, { recursive: true, mode: 0o700 })
  const output = await realpath(options.output)
  if (within(workspace, output)) throw new Error('Output must be outside the fingerprinted workspace')
  const runId = randomUUID()
  const runDir = join(output, runId)
  await mkdir(runDir, { mode: 0o700 })
  const identity = await workspaceIdentity(workspace)
  if (options.deploymentRecord) await verifyDeploymentRecord(options.deploymentRecord, workspace, identity, options.buildId)
  const storageState = options.storageState
    ? parseStorageState(await readPrivateJson(options.storageState, workspace), suite.baseUrl)
    : undefined
  const manifest: RunManifest = {
    version: 1,
    runId,
    card: options.card,
    status: 'running',
    startedAt: new Date().toISOString(),
    identity: {
      workspace,
      ...identity,
      suiteSha256: sha256(source),
      buildId: options.buildId,
      buildVerified: false,
      model: options.model,
      midscene: '1.12.6',
      playwright: '1.63.0',
    },
    counts: {
      cases: suite.cases.length,
      completedCases: 0,
      assertions: suite.cases.flatMap(c => c.steps).filter(s => s.kind === 'assert' || s.kind === 'text').length,
      passedAssertions: 0,
      steps: suite.cases.flatMap(c => c.steps).length,
      completedSteps: 0,
    },
    results: [],
    cleanup: 'pending',
    usage: 'unavailable',
    reports: {
      markdown: 'test-report.md',
      html: 'report.html',
      results: 'results.json',
      baseUrl: reportBase(runDir, options.reportBaseUrl, runId),
    },
  }
  retainRecheckSnapshot(manifest, storageState)
  await writeManifest(runDir, manifest)
  options.onProgress?.(`run ${runId} started`)
  if (options.signal?.aborted) {
    manifest.status = 'cancelled'
    manifest.cleanup = 'confirmed'
  } else await executeWorker(options, suite, runDir, manifest, storageState)
  if (manifest.status === 'passed') {
    const after = await workspaceIdentity(workspace)
    if (
      after.workspaceSha256 !== identity.workspaceSha256 ||
      after.commit !== identity.commit ||
      sha256(await readFile(resolve(options.suite))) !== manifest.identity.suiteSha256
    ) {
      manifest.status = 'infrastructure-error'
      manifest.reason = 'Inputs changed during execution'
    }
  }
  if (manifest.status === 'passed' && options.signal?.aborted) manifest.status = 'cancelled'
  if (manifest.status === 'passed' && Date.now() >= deadline) manifest.status = 'timed-out'
  manifest.endedAt = new Date().toISOString()
  try {
    await finalizeReports(runDir, manifest)
    if (
      manifest.status === 'passed' &&
      !(await publicationAvailable(
        runDir,
        manifest.reports.baseUrl,
        [
          'report.html',
          ...manifest.results.flatMap(r =>
            [r.report, r.screenshot].filter((path): path is string => path !== undefined),
          ),
        ],
        Math.max(1, deadline - Date.now()),
        options.signal,
      ))
    ) {
      manifest.status = options.signal?.aborted
        ? 'cancelled'
        : Date.now() >= deadline
          ? 'timed-out'
          : 'infrastructure-error'
      manifest.reason = 'Report publication unavailable'
      await finalizeReports(runDir, manifest)
    }
  } catch {
    manifest.status = 'infrastructure-error'
    manifest.reason = 'Report finalization failed'
    await writeManifest(runDir, manifest)
  }
  options.onProgress?.(`run ${runId} ${manifest.status}; manifest ${join(runDir, 'manifest.json')}`)
  return manifest
}
async function executeWorker(
  options: RunOptions,
  suite: WorkerInput['suite'],
  runDir: string,
  manifest: RunManifest,
  storageState?: WorkerInput['storageState'],
): Promise<void> {
  const worker = fileURLToPath(new URL('./cli' + extname(fileURLToPath(import.meta.url)), import.meta.url))
  const child = fork(worker, ['--worker'], {
    cwd: runDir,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...childEnvironment(options.environment), MIDSCENE_RUN_DIR: join(runDir, 'midscene'), MIDSCENE_MODEL_NAME: options.model },
    execArgv: [],
  })
  const state = { complete: false, buildVerified: false }
  let infrastructure = false
  const hasInfrastructureFailure = (): boolean => infrastructure
  let writes = Promise.resolve()
  let browserPid: number | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const terminate = (status: 'cancelled' | 'timed-out') => {
    if (manifest.status !== 'running') return
    manifest.status = status
    if (child.connected)
      child.send({ type: 'cancel' }, () => {
        /* Escalation still runs if IPC is unavailable. */
      })
    killTimer = setTimeout(() => {
      if (child.pid)
        void terminateOwnedTree(child.pid, browserPid, options.cleanupTimeoutMs).catch(() => {
          infrastructure = true
          child.kill('SIGKILL')
        })
    }, options.cleanupTimeoutMs)
  }
  const abort = () => {
    terminate('cancelled')
  }
  const timer = setTimeout(() => {
    terminate('timed-out')
  }, options.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') {
      infrastructure = true
      return
    }
    const event = message as Record<string, unknown>
    switch (event.type) {
      case 'browser-owned':
        if (!Number.isSafeInteger(event.pid) || Number(event.pid) <= 1) infrastructure = true
        else browserPid = Number(event.pid)
        break
      case 'usage': {
        const fields = ['promptTokens', 'completionTokens', 'totalTokens'] as const
        if (
          fields.some(key => event[key] !== null && (!Number.isSafeInteger(event[key]) || Number(event[key]) < 0))
        ) {
          infrastructure = true
          break
        }
        if (manifest.usage === 'unavailable')
          manifest.usage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        manifest.usage.calls++
        for (const key of fields)
          manifest.usage[key] =
            manifest.usage[key] === null || event[key] === null ? null : manifest.usage[key] + Number(event[key])
        break
      }
      case 'build-verified':
        if (suite.buildProbe.instanceField && (typeof event.targetInstanceId !== 'string' || !event.targetInstanceId)) {
          infrastructure = true
          break
        }
        if (typeof event.targetInstanceId === 'string') manifest.identity.targetInstanceId = event.targetInstanceId
        state.buildVerified = true
        manifest.identity.buildVerified = true
        break
      case 'case-start':
      case 'step-start':
      case 'step-complete':
        options.onProgress?.(
          `${event.type} case=${Number(event.index)}${event.stepIndex !== undefined ? ` step=${Number(event.stepIndex)}` : ''}`,
        )
        break
      case 'case-complete': {
        const result = caseResult(event.result)
        const expected = suite.cases[manifest.results.length]
        if (
          !result ||
          !expected ||
          result.id !== expected.id ||
          result.completedSteps < 0 ||
          result.completedSteps > expected.steps.length ||
          result.passedAssertions < 0 ||
          result.passedAssertions > expected.steps.filter(s => s.kind === 'assert' || s.kind === 'text').length
        ) {
          infrastructure = true
          break
        }
        manifest.results.push(result)
        manifest.counts.completedCases++
        manifest.counts.completedSteps += result.completedSteps
        manifest.counts.passedAssertions += result.passedAssertions
        const snapshot = structuredClone(manifest)
        writes = writes
          .then(() => writeManifest(runDir, snapshot))
          .catch(() => {
            infrastructure = true
          })
        break
      }
      case 'finished':
        state.complete = true
        manifest.cleanup = event.cleanup === 'confirmed' ? 'confirmed' : 'unknown'
        break
      case 'infrastructure-error':
        infrastructure = true
        break
      default:
        infrastructure = true
    }
  })
  await new Promise<void>((resolveExit) => {
    child.once('error', () => {
      infrastructure = true
      resolveExit()
    })
    child.once('close', (code) => {
      if (code !== 0) infrastructure = true
      resolveExit()
    })
    const input: WorkerInput = {
      suite,
      ...(storageState ? { storageState } : {}),
      runDir,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      maxSteps: options.maxSteps,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    }
    child.send(input, (error) => {
      if (error) {
        infrastructure = true
        child.kill('SIGTERM')
      }
    })
  })
  if (manifest.cleanup !== 'confirmed' && child.pid && browserPid !== undefined) {
    try {
      await terminateOwnedTree(child.pid, browserPid, options.cleanupTimeoutMs)
    } catch {
      infrastructure = true
    }
  }
  clearTimeout(timer)
  clearTimeout(killTimer)
  options.signal?.removeEventListener('abort', abort)
  await writes
  if (manifest.cleanup === 'pending') manifest.cleanup = 'unknown'
  if (manifest.status !== 'running') return
  if (!state.complete) {
    manifest.status = 'interrupted'
    return
  }
  if (
    hasInfrastructureFailure() ||
    !state.buildVerified ||
    manifest.cleanup !== 'confirmed' ||
    manifest.results.some(r => r.status === 'infrastructure-error') ||
    manifest.counts.completedCases !== manifest.counts.cases
  )
    manifest.status = 'infrastructure-error'
  else if (manifest.results.some(r => r.status === 'assertion-failed')) manifest.status = 'assertion-failed'
  else if (
    manifest.counts.completedSteps !== manifest.counts.steps ||
    manifest.counts.passedAssertions !== manifest.counts.assertions ||
    manifest.results.some(r => !r.report || !r.screenshot)
  )
    manifest.status = 'infrastructure-error'
  else manifest.status = 'passed'
}

/** Inspect historical files without granting them authority to skip a gate rerun.
 * A live process and an abandoned process cannot be distinguished from this record;
 * the persisted running state is therefore explicitly unknown until the owner commits.
 */
export async function inspectRun(
  runDir: string,
  timeoutMs = 5000,
): Promise<{ status: string; reportAvailable: boolean; manifest: unknown }> {
  const value: unknown = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'))
  if (!value || typeof value !== 'object') throw new Error('Invalid manifest')
  const v = value as Record<string, unknown>
  const statuses = [
    'running',
    'passed',
    'assertion-failed',
    'infrastructure-error',
    'cancelled',
    'timed-out',
    'interrupted',
  ]
  if (
    v.version !== 1 ||
    typeof v.status !== 'string' ||
    !statuses.includes(v.status) ||
    typeof v.runId !== 'string' ||
    !Array.isArray(v.results) ||
    !v.counts ||
    typeof v.counts !== 'object'
  )
    throw new Error('Invalid manifest')
  const results = v.results.map((value) => {
    const result = caseResult(value)
    if (!result) throw new Error('Invalid results')
    return result
  })
  const counts = v.counts as Record<string, unknown>
  for (const field of ['cases', 'completedCases', 'steps', 'completedSteps', 'assertions', 'passedAssertions'])
    if (!Number.isSafeInteger(counts[field]) || Number(counts[field]) < 0) throw new Error('Invalid counts')
  const paths = [
    'report.html',
    'test-report.md',
    'results.json',
    ...results.flatMap(r => [r.report, r.screenshot].filter((path): path is string => path !== undefined)),
  ]
  const localAvailable = (
    await Promise.all(
      paths.map(path =>
        readFile(join(runDir, path)).then(
          b => b.length > 0,
          () => false,
        ),
      ),
    )
  ).every(Boolean)
  const reportFields = v.reports && typeof v.reports === 'object' ? (v.reports as Record<string, unknown>) : {}
  const reportAvailable = localAvailable && (await publicationAvailable(runDir, reportFields.baseUrl, paths, timeoutMs))
  const complete =
    counts.cases === results.length &&
    counts.completedCases === counts.cases &&
    counts.cases > 0 &&
    counts.steps === counts.completedSteps &&
    Number(counts.assertions) > 0 &&
    counts.assertions === counts.passedAssertions &&
    results.every(r => r.status === 'passed' && r.report && r.screenshot) &&
    v.cleanup === 'confirmed' &&
    typeof v.endedAt === 'string'
  return {
    status:
      v.status === 'running'
        ? 'unknown'
        : v.status === 'passed' && (!reportAvailable || !complete)
          ? 'infrastructure-error'
          : v.status,
    reportAvailable,
    manifest: value,
  }
}
