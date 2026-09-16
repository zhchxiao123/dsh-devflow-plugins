/** Session-owned jobs share the same execution core with fresh completion validators. */
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@zhchxiao123/dsh-devflow-gates'
import type { AcceptanceProfile, Config } from './config.ts'
import { recoverExploration } from './recovery.ts'
import { exploreBrowser } from './browser.ts'
import { resolveModel } from './model.ts'
import { parseSuite } from './suite.ts'
import { verifyDeploymentRecord } from './deployment.ts'
import { sha256, within, workspaceIdentity } from './identity.ts'
import { inspectRun, runAcceptance, recheckAcceptance } from './runner.ts'
import type { RunManifest } from './types.ts'
import { recordPreflight } from './summary.ts'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { midscene: 'midscene' } }

/** Canonical session cwd is the only workspace selector accepted from tool calls. */
export async function selectProfile(config: Config, exec: ToolRunContext, name?: string): Promise<[string, AcceptanceProfile, Agent]> {
  const owner = exec.agent
  const cwd = owner?.session.header.cwd
  if (!owner || !cwd) throw new Error('Midscene requires an owning workspace session')
  const root = await realpath(cwd)
  const matches: [string, AcceptanceProfile][] = []
  for (const entry of Object.entries(config.profiles)) {
    if (name !== undefined && name !== entry[0]) continue
    if (await realpath(entry[1].workspace) === root) matches.push(entry)
  }
  const match = matches[0]
  if (matches.length !== 1 || !match) throw new Error('MIDSCENE_PROFILE_REQUIRED: select one configured profile for this workspace')
  return [match[0], match[1], owner]
}

/** Formal acceptance pins an approved suite and a separate deployment receipt. */
export async function runManaged(
  ctx: Context, p: AcceptanceProfile, card: string, signal: AbortSignal, progress: (text: string) => void,
): Promise<RunManifest> {
  if (!p.suite || !p.suiteSha256 || !p.buildId || !p.deploymentRecord)
    throw new Error('ACCEPTANCE_NOT_CONFIGURED: approved suite, build and deployment receipt are required')
  const suite = await realpath(resolve(p.workspace, p.suite))
  if (!within(await realpath(p.workspace), suite)) throw new Error('Approved suite must be inside its workspace')
  const bytes = await readFile(suite)
  if (sha256(bytes) !== p.suiteSha256) throw new Error('INPUT_CHANGED: approved suite changed')
  const definition = parseSuite(JSON.parse(bytes.toString('utf8')) as unknown, p.maxSteps)
  if (new URL(definition.baseUrl).origin !== new URL(p.targetUrl).origin) throw new Error('TARGET_MISMATCH: approved suite belongs to another origin')
  const model = await resolveModel(ctx, p, signal)
  return runAcceptance({
    suite, workspace: p.workspace, output: p.output, card, buildId: p.buildId, model: p.model,
    timeoutMs: p.timeoutMs, cleanupTimeoutMs: p.cleanupTimeoutMs, maxSteps: p.maxSteps,
    environment: model.environment, signal, onProgress: (text) => { progress(model.redact(text)) },
    deploymentRecord: p.deploymentRecord,
    ...(p.storageState ? { storageState: p.storageState } : {}),
    ...(p.executablePath ? { executablePath: p.executablePath } : {}),
  }).catch((error: unknown) => {
    throw new Error(model.redact(error instanceof Error ? error.message : 'Midscene failed'))
  })
}

/** Both human-visible tools and validators use the existing owner-scoped job registry. */
function startJob(
  ctx: Context, exec: ToolRunContext, label: string,
  run: (signal: AbortSignal, progress: (text: string) => void) => Promise<string>,
): string {
  const jobs = ctx.get('jobs')
  if (!jobs || !exec.agent) throw new Error('JOBS_UNAVAILABLE: Midscene needs a live owner and jobs controller')
  return jobs.start({ kind: 'midscene', owner: exec.agent, label,
    run: () => {
      const controller = new AbortController()
      let output = ''
      const progress = (text: string) => { output = (output + text + '\n').slice(-65536) }
      const done: Promise<JobOutcome> = run(controller.signal, progress).then(
        text => ({ status: controller.signal.aborted ? 'killed' as const : 'completed' as const, output: text }),
        (error: unknown) => ({ status: controller.signal.aborted ? 'killed' as const : 'failed' as const, output: error instanceof Error ? error.message : 'Midscene failed' }),
      ).then((outcome) => { progress(outcome.output); return outcome })
      return { cancel: () => { controller.abort() }, done, readOutput: () => { const current = output; output = ''; return current } }
    },
  })
}

const PROFILE = { type: 'string', description: 'Configured Midscene profile for this workspace.' } as const
const TEXT_OUTPUT = { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
} as const

/** Report links use the authenticated host route; manifests retain their exact-byte file links. */
function reportUrl(p: AcceptanceProfile, session: string, runId: string, asset: string): string {
  if (p.reportBaseUrl === undefined) return pathToFileURL(join(p.output, runId, asset)).href
  return new URL(`/devflow/reports/${encodeURIComponent(session)}/${encodeURIComponent(runId)}/${asset.split('/').map(encodeURIComponent).join('/')}`, p.reportBaseUrl).href
}

/** Resolve one configured run without accepting caller paths or cross-output symlinks. */
async function runDirectory(p: AcceptanceProfile, runId: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run id')
  const directory = join(await realpath(p.output), runId)
  if (await realpath(directory) !== directory) throw new Error('Run path is aliased or escaped output')
  return directory
}

/** Register tools only while the host's actual tool registry is mounted. */
export function registerManagedTools(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'midscene_doctor', description: 'Check the selected visual model and formal acceptance configuration without a paid model request.',
    parameters: { profile: PROFILE }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [name, p] = await selectProfile(config, exec, args.profile)
      const checks: string[] = []
      let capability: 'available' | 'unknown' | 'unavailable' = 'unavailable'
      try { capability = (await resolveModel(ctx, p, exec.signal)).capability; checks.push(`model: ${capability}`) }
      catch (error) { checks.push(error instanceof Error ? error.message : 'MODEL_UNAVAILABLE') }
      checks.push(`browser: ${p.browserMode}; target: ${p.targetUrl}`)
      checks.push(`login: ${p.storageState ? 'snapshot configured; validity checked during execution' : p.browserMode === 'puppeteer' ? 'no snapshot' : 'borrowed browser session; connection not yet verified'}`)
      checks.push(`formal acceptance: ${p.suite && p.suiteSha256 && p.buildId && p.deploymentRecord ? 'configured; execution checks pending' : 'missing approved suite/build/deployment receipt'}`)
      checks.push(`gate engine: ${ctx.get('devflowValidators') ? 'available; deployment must require midscene:' + name : 'unavailable'}`)
      try { await recordPreflight(p, name, capability) }
      catch { checks.push('diagnostic persistence: unavailable') }
      return { text: checks.join('\n') }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_browser',
    description: 'Use the pinned official Midscene CLI to observe a configured page, optionally act and visually assert. Returns a job: wait and read its screenshots before another request. Exploration never authorizes card completion. Uses a fresh owned browser or explicitly configured borrowed Chrome.',
    parameters: { profile: PROFILE, prompt: { type: 'string', description: 'Optional natural-language action; never include secrets.' }, assertion: { type: 'string', description: 'Optional expected visible state.' } },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [name, p, owner] = await selectProfile(config, exec, args.profile)
      const model = await resolveModel(ctx, p, exec.signal)
      const id = startJob(ctx, exec, `Midscene exploration (${name})`, async (signal, progress) => {
        const result = await exploreBrowser(p, args, model, signal, progress).catch((error: unknown) => {
          throw new Error(model.redact(error instanceof Error ? error.message : 'Midscene failed'))
        })
        if (result.status === 'infrastructure-error' || result.status === 'assertion-failed' || result.status === 'cancelled') throw new Error(JSON.stringify(result))
        return JSON.stringify({ ...result, reportUrls: result.artifacts.map(asset => reportUrl(p, owner.id, result.runId, asset)) })
      })
      return { text: `Started ${id}. Read job output and screenshots; this is exploration, not formal acceptance.` }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_run', description: 'Run the configured approved acceptance suite as an owner-scoped job. Completion gates must still run fresh acceptance.',
    parameters: { profile: PROFILE, card: { type: 'string', required: true, description: 'Existing Devflow card id in this workspace.' } }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [, p, owner] = await selectProfile(config, exec, args.profile)
      const devflow = ctx.get('devflow')
      if (!devflow) throw new Error('Devflow unavailable')
      const { DevflowCardId } = await import('@zhchxiao123/dsh-devflow')
      await devflow.read(DevflowCardId(args.card), join(p.workspace, '.devflow'))
      const id = startJob(ctx, exec, `Midscene acceptance (${args.card})`, async (signal, progress) => {
        const result = await runManaged(ctx, p, args.card, signal, progress)
        const text = JSON.stringify({ ...result, reportUrl: reportUrl(p, owner.id, result.runId, result.reports.markdown) })
        if (result.status !== 'passed') throw new Error(text)
        return text
      })
      return { text: `Started ${id}. Use job tools to observe or cancel; register the generated Markdown after checking the result.` }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_inspect', description: 'Read an acceptance run after completion or restart. Historical evidence never replaces a fresh completion gate.',
    parameters: { profile: PROFILE, runId: { type: 'string', required: true } }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [, p, owner] = await selectProfile(config, exec, args.profile)
      const directory = await runDirectory(p, args.runId)
      let exploration: unknown
      try { exploration = JSON.parse(await readFile(join(directory, 'exploration.json'), 'utf8')) }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      if (exploration !== undefined) {
        if (!exploration || typeof exploration !== 'object' || !('purpose' in exploration) || exploration.purpose !== 'exploration'
          || !('runId' in exploration) || exploration.runId !== args.runId || !('status' in exploration)
          || !('workspace' in exploration) || exploration.workspace !== await realpath(p.workspace)
          || !['running', 'passed', 'observed', 'assertion-failed', 'infrastructure-error', 'cancelled', 'interrupted'].includes(String(exploration.status))) throw new Error('Invalid exploration record')
        return { text: JSON.stringify({ ...exploration, status: exploration.status === 'running' ? 'unknown' : exploration.status, reportUrl: reportUrl(p, owner.id, args.runId, 'exploration.json') }) }
      }
      const inspected = await inspectRun(directory)
      const manifest = inspected.manifest
      if (!manifest || typeof manifest !== 'object' || !('identity' in manifest) || !manifest.identity || typeof manifest.identity !== 'object'
        || !('workspace' in manifest.identity) || manifest.identity.workspace !== await realpath(p.workspace)) throw new Error('Run workspace mismatch')
      return { text: JSON.stringify({ ...inspected, reportUrl: reportUrl(p, owner.id, args.runId, 'test-report.md') }) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_recover',
    description: 'Recover an interrupted exploration after restart. Stops only positively identified owned resources; never repeats browser actions.',
    parameters: { profile: PROFILE, runId: { type: 'string', required: true } }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [, p, owner] = await selectProfile(config, exec, args.profile)
      const directory = await runDirectory(p, args.runId)
      const result = await recoverExploration(directory, await realpath(p.workspace), p.cleanupTimeoutMs)
      return { text: JSON.stringify({ ...result, reportUrl: reportUrl(p, owner.id, args.runId, 'exploration.json') }) }
    },
  }))
}

/** Each validator registration is revoked with the plugin fiber. */
export function registerManagedValidators(ctx: Context, config: Config): void {
  const validators = ctx.get('devflowValidators')
  if (!validators) return
  for (const [name, p] of Object.entries(config.profiles)) ctx.effect(() => validators.register(`midscene:${name}`, async (request) => {
    const workspace = await realpath(p.workspace)
    if (await realpath(dirname(request.attempt.root)) !== workspace) {
      return { allowed: false, reason: 'Midscene profile belongs to another workspace' }
    }
    const { SessionId } = await import('@deepseek-ai/dsh-session')
    const owner = request.attempt.by.kind === 'agent' && request.attempt.by.session !== undefined
      ? ctx.get('agents')?.get(SessionId(request.attempt.by.session)) : undefined
    const jobs = ctx.get('jobs')
    if (!owner || !jobs || !owner.session.header.cwd) {
      return { allowed: false, reason: 'GATE_UNAVAILABLE: Midscene requires a live owning session and jobs controller' }
    }
    if (await realpath(owner.session.header.cwd) !== workspace) {
      return { allowed: false, reason: 'GATE_UNAVAILABLE: initiating session belongs to another workspace' }
    }
    if (request.signal.aborted) return { allowed: false, reason: 'Midscene gate was cancelled before execution' }
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, controller.signal])
    let jobId = ''
    let completion!: Promise<import('@zhchxiao123/dsh-devflow-gates').GateValidationResult>
    jobId = jobs.start({
      kind: 'midscene', owner, label: `Midscene completion gate (${request.attempt.id})`,
      run: () => {
        let output = ''
        const progress = (text: string): void => { output = (output + text + '\n').slice(-65536) }
        completion = Promise.resolve().then(async () => {
          const directory = join(p.output, 'gates')
          const { mkdir } = await import('node:fs/promises')
          await mkdir(directory, { recursive: true, mode: 0o700 })
          let result: RunManifest | undefined
          let verdict: import('@zhchxiao123/dsh-devflow-gates').GateValidationResult
          try {
            signal.throwIfAborted()
            const remaining = request.deadline - Date.now()
            if (remaining <= 0) throw new Error('deadline elapsed')
            result = await runManaged(ctx, { ...p, timeoutMs: Math.min(p.timeoutMs, remaining) }, request.attempt.id, signal, progress)
            const accepted = result
            const counts = result.counts
            const complete = !signal.aborted && result.status === 'passed' && result.cleanup === 'confirmed'
              && result.identity.buildVerified && result.identity.buildId === p.buildId
              && result.identity.suiteSha256 === p.suiteSha256 && result.identity.model === p.model
              && await realpath(result.identity.workspace) === workspace && result.card === request.attempt.id
              && Object.values(counts).every(value => Number.isSafeInteger(value) && value > 0)
              && counts.cases === counts.completedCases && counts.assertions === counts.passedAssertions
              && counts.steps === counts.completedSteps && result.results.length === counts.cases
              && result.results.every(entry => entry.status === 'passed' && Boolean(entry.report) && Boolean(entry.screenshot))
            verdict = complete
              ? { allowed: true, runId: result.runId, summary: `Midscene ${name}: complete fresh acceptance; jobId=${jobId}`,
                revalidate: async () => {
                  if (signal.aborted || Date.now() >= request.deadline) return false
                  const current = await workspaceIdentity(workspace)
                  if (current.commit !== accepted.identity.commit
                    || current.workspaceSha256 !== accepted.identity.workspaceSha256) return false
                  if (!p.suite || !p.deploymentRecord) return false
                  const suite = await realpath(resolve(workspace, p.suite))
                  if (!within(workspace, suite) || sha256(await readFile(suite)) !== accepted.identity.suiteSha256) return false
                  await verifyDeploymentRecord(p.deploymentRecord, workspace, current, accepted.identity.buildId)
                  signal.throwIfAborted()
                  await recheckAcceptance({ suite, workspace, output: p.output, card: accepted.card, buildId: accepted.identity.buildId,
                    model: p.model, timeoutMs: Math.max(1, Math.min(p.timeoutMs, request.deadline - Date.now())),
                    cleanupTimeoutMs: p.cleanupTimeoutMs, maxSteps: p.maxSteps, deploymentRecord: p.deploymentRecord, signal }, accepted)
                  return Date.now() < request.deadline
                } }
              : { allowed: false, reason: `Midscene ${signal.aborted ? 'cancelled' : result.status}; incomplete acceptance or cleanup; runId=${result.runId}; jobId=${jobId}` }
          } catch {
            // Secrets can occur in thrown transport errors; retain only the safe failure class.
            verdict = { allowed: false, reason: `Midscene ${signal.aborted ? 'cancelled' : 'unavailable'}; jobId=${jobId}; requestId=${request.requestId}` }
          }
          const record = JSON.stringify({
            requestId: request.requestId, jobId, runId: result?.runId, verdict,
            card: request.attempt.id, root: request.attempt.root, expectedRevision: request.attempt.expectedRevision,
            from: request.attempt.from, to: request.attempt.to, by: request.attempt.by,
            completedAt: new Date().toISOString(),
          }, null, 2) + '\n'
          await writeFile(join(directory, `${request.requestId}.json`), record, { mode: 0o600 })
          if (result) await writeFile(join(p.output, result.runId, 'gate.json'), record, { mode: 0o600 })
          progress(record)
          return verdict
        }).catch(() => ({ allowed: false, reason: `Midscene gate evidence unavailable; jobId=${jobId}` }))
        const done: Promise<JobOutcome> = completion.then(verdict => ({
          status: signal.aborted ? 'killed' : verdict.allowed ? 'completed' : 'failed',
          detail: verdict.allowed ? `runId=${verdict.runId}` : verdict.reason,
        }))
        return {
          cancel: () => { controller.abort() }, done,
          readOutput: () => { const current = output; output = ''; return current },
        }
      },
    })
    // Await the producer, not a cancelled wait: it resolves only after worker cleanup and durable evidence.
    return await completion
  }))
}
