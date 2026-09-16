/** Session-owned jobs share the same execution core with fresh completion validators. */
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { DevCard } from '@zhchxiao123/dsh-devflow'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@zhchxiao123/dsh-devflow-gates'
import type { AcceptanceProfile, Config } from './config.ts'
import { recoverExploration } from './recovery.ts'
import { exploreBrowser } from './browser.ts'
import { resolveModel } from './model.ts'
import type { ModelEnvironment } from './model.ts'
import { parseSuite } from './suite.ts'
import { verifyDeploymentRecord } from './deployment.ts'
import { sha256, within, workspaceIdentity } from './identity.ts'
import { inspectRun, runAcceptance, recheckAcceptance } from './runner.ts'
import type { RunManifest } from './types.ts'
import { recordPreflight } from './summary.ts'
import { checkDshModel, startDshModelBridge } from './model-bridge.ts'
import { projectHistoryProfile, resolveProjectProfile } from './project-runtime.ts'
import { readProjectFile, readSettings } from './project-settings.ts'
import { archiveRun } from './report-archive.ts'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { midscene: 'midscene' } }

/** Canonical session cwd is the only workspace selector accepted from tool calls. */
export async function selectProfile(
  config: Config, exec: ToolRunContext, name?: string,
  options: { targetUrl?: string; app?: string; card?: string; history?: boolean } = {},
): Promise<[string, AcceptanceProfile, Agent]> {
  const owner = exec.agent
  const cwd = owner?.session.header.cwd
  if (!owner || !cwd) throw new Error('Midscene requires an owning workspace session')
  const root = await realpath(cwd)
  const project = async (): Promise<[string, AcceptanceProfile, Agent]> => ['project', options.history ? await projectHistoryProfile(owner) : await resolveProjectProfile(owner, options, options.card), owner]
  if (name === 'project' || (name === undefined && await readProjectFile(root, '.devflow/midscene/settings.json') !== undefined)) return project()
  const matches: [string, AcceptanceProfile][] = []
  for (const entry of Object.entries(config.profiles)) {
    if (name !== undefined && name !== entry[0]) continue
    let workspace: string
    try { workspace = await realpath(entry[1].workspace) }
    catch (error) {
      if (name === undefined && error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue
      throw error
    }
    if (workspace === root) matches.push(entry)
  }
  if (name === undefined && matches.length === 0) return project()
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
  const model = await runtimeModel(ctx, p, signal)
  try { return await runAcceptance({
    suite, workspace: p.workspace, output: p.output, card, buildId: p.buildId, model: p.model,
    timeoutMs: p.timeoutMs, cleanupTimeoutMs: p.cleanupTimeoutMs, maxSteps: p.maxSteps,
    environment: model.environment, signal, onProgress: (text) => { progress(model.redact(text)) },
    deploymentRecord: p.deploymentRecord,
    ...(p.storageState ? { storageState: p.storageState } : {}),
    ...(p.executablePath ? { executablePath: p.executablePath } : {}),
  }).catch((error: unknown) => {
    throw new Error(model.redact(error instanceof Error ? error.message : 'Midscene failed'))
  }) } finally { await model.dispose?.() }
}

async function runtimeModel(ctx: Context, p: AcceptanceProfile, signal: AbortSignal): Promise<ModelEnvironment> {
  if (p.modelSource === 'dsh') {
    if (!p.provider) throw new Error('MODEL_NOT_CONFIGURED: DSH provider required')
    return startDshModelBridge(ctx, { provider: p.provider, model: p.model, family: p.family }, signal)
  }
  return resolveModel(ctx, p, signal)
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

const PROFILE = { type: 'string', description: 'Optional legacy profile; defaults to automatic current-project discovery.' } as const
const TARGET = { type: 'string', description: 'Optional target URL discovered from this project or explicitly requested by the user.' } as const
const TEXT_OUTPUT = { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
} as const

/** Report links use the authenticated host route; manifests retain their exact-byte file links. */
function reportUrl(p: AcceptanceProfile, session: string, runId: string, asset: string): string {
  if (p.modelSource === 'dsh') return `/devflow/reports/${encodeURIComponent(session)}/${encodeURIComponent(runId)}/${asset.split('/').map(encodeURIComponent).join('/')}`
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

/** HTML needs its own artifact row: the host Markdown renderer does not follow project-relative links. */
async function attachArchive(
  devflow: Context['devflow'], workspace: string, card: DevCard, owner: Agent,
  runId: string, archived: Awaited<ReturnType<typeof archiveRun>>,
): Promise<void> {
  const root = join(workspace, '.devflow')
  let current = card
  for (const path of archived.htmlFiles) {
    if (current.artifacts.includes(path)) continue
    const result = await devflow.attachArtifact({ id: current.id, root, expectedRevision: current.stageRevision,
      by: { kind: 'agent', session: owner.id }, path })
    if (!result.ok) throw new Error('REPORT_ATTACHMENT_FAILED: ' + JSON.stringify(result) + '; runId=' + runId)
    current = result.card
  }
  const result = await devflow.attachArtifact({ id: current.id, root, expectedRevision: current.stageRevision,
    by: { kind: 'agent', session: owner.id }, kind: 'test-report', content: archived.attachment })
  if (!result.ok) throw new Error('REPORT_ATTACHMENT_FAILED: ' + JSON.stringify(result) + '; runId=' + runId)
}

/** Register tools only while the host's actual tool registry is mounted. */
export function registerManagedTools(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'midscene_doctor', description: 'Check visual model metadata and preparation needs without browser actions or paid model calls. Pass card to inspect its formal acceptance binding; omitting card does not diagnose missing project acceptance.',
    parameters: { profile: PROFILE, targetUrl: TARGET, card: { type: 'string', description: 'Current Devflow card id; required to diagnose its project acceptance binding.' } }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [name, p] = await selectProfile(config, exec, args.profile, args)
      const checks: string[] = []
      let capability: 'available' | 'unknown' | 'unavailable' = 'unavailable'
      try { capability = p.modelSource === 'dsh' && p.provider ? await checkDshModel(ctx, { provider: p.provider, model: p.model, family: p.family }, exec.signal) : (await resolveModel(ctx, p, exec.signal)).capability; checks.push(`model: ${capability}`) }
      catch (error) { checks.push(error instanceof Error ? error.message : 'MODEL_UNAVAILABLE') }
      checks.push(`browser: ${p.browserMode}; target: ${p.targetUrl}`)
      checks.push(`login: ${p.storageState ? 'snapshot configured; validity checked during execution' : p.browserMode === 'puppeteer' ? 'no snapshot' : 'borrowed browser session; connection not yet verified'}`)
      checks.push('exploration: metadata check only; application reachability, login validity and visual actions are not tested')
      if (name === 'project' && args.card === undefined) {
        checks.push('formal acceptance: not checked; select the current card and call midscene_doctor with card')
      } else {
        const missing = [['approved suite', p.suite], ['suite approval hash', p.suiteSha256], ['build identity', p.buildId], ['deployment receipt reference', p.deploymentRecord]]
          .filter(([, value]) => !value).map(([label]) => label)
        checks.push('formal acceptance: ' + (missing.length ? 'preparation required; missing ' + missing.join(', ') : 'configured; file validity, deployment identity and execution checks pending'))
        if (missing.length) checks.push('next: prepare the acceptance suite and genuine deployment evidence, then use midscene_bind for the current card; do not fabricate a receipt')
      }
      checks.push(ctx.get('devflowValidators')
        ? 'completion checks: service available; the card must require midscene:' + name + ' and pass fresh execution before completion'
        : 'completion checks: service unavailable; inspect devflow-gates plugin loading and its shell dependency in this DSH instance')
      checks.push('scope: midscene_browser can collect exploration evidence, but never substitutes for a card’s required completion checks')
      try { await recordPreflight(p, name, capability) }
      catch { checks.push('diagnostic persistence: unavailable') }
      return { text: checks.join('\n') }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_browser',
    description: 'Use the pinned official Midscene CLI to observe a configured page, optionally act and visually assert. Returns a job: wait and read its screenshots before another request. Exploration never authorizes card completion. Uses a fresh owned browser or explicitly configured borrowed Chrome.',
    parameters: { profile: PROFILE, targetUrl: TARGET, card: { type: 'string', description: 'Optional existing card that should receive this exploration report.' }, prompt: { type: 'string', description: 'Optional natural-language action; never include secrets.' }, assertion: { type: 'string', description: 'Optional expected visible state.' } },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [name, p, owner] = await selectProfile(config, exec, args.profile, args)
      const devflow = ctx.get('devflow')
      const { DevflowCardId } = await import('@zhchxiao123/dsh-devflow')
      if (args.card && !devflow) throw new Error('Devflow unavailable')
      const card = args.card ? await devflow?.read(DevflowCardId(args.card), join(p.workspace, '.devflow')) : undefined
      const id = startJob(ctx, exec, `Midscene exploration (${name})`, async (signal, progress) => {
        const model = await runtimeModel(ctx, p, signal)
        try { const result = await exploreBrowser(p, args, model, signal, progress).catch((error: unknown) => {
          throw new Error(model.redact(error instanceof Error ? error.message : 'Midscene failed'))
        })
        let cardReport: string | undefined
        if (card && devflow) {
          const archived = await archiveRun(p.workspace, p.output, card.id, result.runId)
          cardReport = archived.html
          await attachArchive(devflow, p.workspace, card, owner, result.runId, archived)
        }
        const text = JSON.stringify({ ...result, cardReport,
          reportUrls: result.artifacts.map(asset => reportUrl(p, owner.id, result.runId, asset)),
          ...(!card ? { archiveHint: 'Use midscene_archive with card and runId to copy this report into a card.' } : {}) })
        if (result.status === 'infrastructure-error' || result.status === 'assertion-failed' || result.status === 'cancelled') throw new Error(text)
        return text
        } finally { await model.dispose?.() }
      })
      return { text: `Started ${id}. Read job output and screenshots; this is exploration, not formal acceptance.` }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_run', description: 'Run the configured approved acceptance suite as an owner-scoped job. Completion gates must still run fresh acceptance.',
    parameters: { profile: PROFILE, card: { type: 'string', required: true, description: 'Existing Devflow card id in this workspace.' } }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [, p, owner] = await selectProfile(config, exec, args.profile, args)
      const devflow = ctx.get('devflow')
      if (!devflow) throw new Error('Devflow unavailable')
      const { DevflowCardId } = await import('@zhchxiao123/dsh-devflow')
      const card = await devflow.read(DevflowCardId(args.card), join(p.workspace, '.devflow'))
      const id = startJob(ctx, exec, `Midscene acceptance (${args.card})`, async (signal, progress) => {
        const result = await runManaged(ctx, p, args.card, signal, progress)
        const url = reportUrl(p, owner.id, result.runId, result.reports.markdown)
        const archived = await archiveRun(p.workspace, p.output, args.card, result.runId)
        const text = JSON.stringify({ ...result, reportUrl: url, cardReport: archived.html })
        await attachArchive(devflow, p.workspace, card, owner, result.runId, archived)
        if (result.status !== 'passed') throw new Error(text)
        return text
      })
      return { text: `Started ${id}. Use job tools to observe or cancel; terminal reports are archived under the card and registered automatically.` }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_archive', description: 'Copy published HTML and screenshots from a completed run into an existing project card and register its Markdown report. Historical exploration remains exploration; this never authorizes completion.',
    parameters: { profile: PROFILE, card: { type: 'string', required: true }, runId: { type: 'string', required: true } }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [, p, owner] = await selectProfile(config, exec, args.profile, { history: true })
      const devflow = ctx.get('devflow')
      if (!devflow) throw new Error('Devflow unavailable')
      const { DevflowCardId } = await import('@zhchxiao123/dsh-devflow')
      const root = join(p.workspace, '.devflow')
      const card = await devflow.read(DevflowCardId(args.card), root)
      const archived = await archiveRun(p.workspace, p.output, args.card, args.runId)
      await attachArchive(devflow, p.workspace, card, owner, args.runId, archived)
      return { text: JSON.stringify({ card: card.id, runId: args.runId, cardReport: archived.html, purpose: archived.purpose }) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'midscene_inspect', description: 'Read an acceptance run after completion or restart. Historical evidence never replaces a fresh completion gate.',
    parameters: { profile: PROFILE, runId: { type: 'string', required: true } }, output: TEXT_OUTPUT,
    async execute(args, exec) {
      const [, p, owner] = await selectProfile(config, exec, args.profile, { history: true })
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
      const [, p, owner] = await selectProfile(config, exec, args.profile, { history: true })
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
  const profiles: [string, AcceptanceProfile | undefined][] = [...Object.entries(config.profiles), ['project', undefined]]
  for (const [name, legacy] of profiles) ctx.effect(() => validators.register(`midscene:${name}`, async (request) => {
    const { SessionId } = await import('@deepseek-ai/dsh-session')
    const owner = request.attempt.by.kind === 'agent' && request.attempt.by.session !== undefined
      ? ctx.get('agents')?.get(SessionId(request.attempt.by.session)) : undefined
    const jobs = ctx.get('jobs')
    if (!owner || !jobs || !owner.session.header.cwd) {
      return { allowed: false, reason: 'GATE_UNAVAILABLE: Midscene requires a live owning session and jobs controller' }
    }
    const p = legacy ?? await resolveProjectProfile(owner, {}, request.attempt.id)
    const workspace = await realpath(p.workspace)
    if (await realpath(dirname(request.attempt.root)) !== workspace) return { allowed: false, reason: 'Midscene profile belongs to another workspace' }
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
            // A transition holds the card commit lock; archive files here without re-entering attachArtifact.
            await archiveRun(workspace, p.output, request.attempt.id, result.runId)
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
                  const settingsFresh = async (): Promise<boolean> => p.modelSource !== 'dsh'
                    || sha256(JSON.stringify(await readSettings(workspace))) === p.projectSettingsHash
                  if (!await settingsFresh()) return false
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
                  return await settingsFresh() && Date.now() < request.deadline
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
