/** Read-only projections of configured profiles, persisted diagnostics and owner jobs. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MidsceneSummary } from '@zhchxiao123/dsh-devflow-web/client'
import type { AcceptanceProfile, Config } from './config.ts'
import { readPrivateJson } from './auth-state.ts'
import { within } from './identity.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type ProfileSummary = MidsceneSummary['profiles'][number]
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid summary record')
  return value as Record<string, unknown>
}
async function record(path: string, workspace: string): Promise<Record<string, unknown> | undefined> {
  try {
    if (await realpath(path) !== path) return undefined
    return object(await readPrivateJson(path, workspace))
  } catch { return undefined }
}

/** Only categorical model availability is persisted: diagnostic errors may contain private data. */
export async function recordPreflight(p: AcceptanceProfile, profile: string, model: 'available' | 'unknown' | 'unavailable'): Promise<void> {
  const workspace = await realpath(p.workspace)
  await mkdir(p.output, { recursive: true, mode: 0o700 })
  const output = await realpath(p.output)
  if (within(workspace, output)) throw new Error('Diagnostic output must be outside workspace')
  const path = join(output, `${profile}.preflight.json`)
  // Exclusive replacement never follows an existing symlink.
  const temp = join(output, `${profile}.${randomUUID()}.preflight.json`)
  await writeFile(temp, JSON.stringify({ workspace, profile, model, modelId: p.model, family: p.family,
    targetUrl: p.targetUrl, browserMode: p.browserMode, login: p.storageState ? 'snapshot' : p.browserMode === 'puppeteer' ? 'none' : 'borrowed',
    formalConfigured: Boolean(p.suite && p.suiteSha256 && p.buildId && p.deploymentRecord), at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  await rename(temp, path)
}

async function profileSummary(
  p: AcceptanceProfile, name: string, workspace: string, sessionId: string, cardId: string,
): Promise<ProfileSummary> {
  const summary: ProfileSummary = {
    name, model: p.model, family: p.family, targetUrl: p.targetUrl, browserMode: p.browserMode,
    login: p.storageState ? 'snapshot' : p.browserMode === 'puppeteer' ? 'none' : 'borrowed',
    formalConfigured: Boolean(p.suite && p.suiteSha256 && p.buildId && p.deploymentRecord),
  }
  let output: string
  try { output = await realpath(p.output) } catch { return summary }
  const preflight = await record(join(output, `${name}.preflight.json`), workspace)
  if (preflight?.workspace === workspace && preflight.profile === name && preflight.modelId === p.model && preflight.family === p.family && typeof preflight.at === 'string'
    && ['available', 'unknown', 'unavailable'].includes(String(preflight.model))) {
    summary.preflight = { at: preflight.at, model: preflight.model as 'available' | 'unknown' | 'unavailable' }
  }
  for (const runId of await readdir(output)) {
    if (!UUID.test(runId)) continue
    const manifest = await record(join(output, runId, 'manifest.json'), workspace)
    if (!manifest || manifest.runId !== runId || manifest.card !== cardId) continue
    let identity: Record<string, unknown>
    try { identity = object(manifest.identity) } catch { continue }
    if (identity.workspace !== workspace || identity.model !== p.model || identity.suiteSha256 !== p.suiteSha256) continue
    if (typeof manifest.startedAt !== 'string' || !['running', 'passed', 'assertion-failed', 'infrastructure-error', 'cancelled', 'timed-out', 'interrupted'].includes(String(manifest.status))) continue
    if (summary.latestRun && summary.latestRun.at >= manifest.startedAt) continue
    summary.latestRun = { runId, at: manifest.startedAt, status: manifest.status === 'running' ? 'unknown' : String(manifest.status) }
    if (p.reportBaseUrl) summary.latestRun.reportUrl = new URL(`/devflow/reports/${encodeURIComponent(sessionId)}/${runId}/test-report.md`, p.reportBaseUrl).href
  }
  return summary
}

/** Historical project evidence does not depend on today's selected model or rediscover the application. */
async function projectSummary(output: string, workspace: string, sessionId: string, cardId: string): Promise<ProfileSummary | undefined> {
  let directory: string
  try { directory = await realpath(output) } catch { return undefined }
  if (within(workspace, directory)) return undefined
  const summary: ProfileSummary = { name: 'project', model: 'unknown', family: 'unknown', targetUrl: '', browserMode: 'puppeteer', login: 'none', formalConfigured: false }
  const preflight = await record(join(directory, 'project.preflight.json'), workspace)
  if (preflight?.workspace === workspace && preflight.profile === 'project'
    && typeof preflight.modelId === 'string' && typeof preflight.family === 'string'
    && typeof preflight.targetUrl === 'string' && typeof preflight.browserMode === 'string'
    && ['snapshot', 'borrowed', 'none'].includes(String(preflight.login))
    && typeof preflight.formalConfigured === 'boolean' && typeof preflight.at === 'string'
    && ['available', 'unknown', 'unavailable'].includes(String(preflight.model))) {
    Object.assign(summary, { model: preflight.modelId, family: preflight.family, targetUrl: preflight.targetUrl,
      browserMode: preflight.browserMode, login: preflight.login, formalConfigured: preflight.formalConfigured,
      preflight: { at: preflight.at, model: preflight.model } })
  }
  for (const runId of await readdir(directory)) {
    if (!UUID.test(runId)) continue
    const manifest = await record(join(directory, runId, 'manifest.json'), workspace)
    if (!manifest || manifest.runId !== runId || manifest.card !== cardId) continue
    let identity: Record<string, unknown>
    try { identity = object(manifest.identity) } catch { continue }
    if (identity.workspace !== workspace || typeof identity.model !== 'string' || typeof manifest.startedAt !== 'string'
      || !['running', 'passed', 'assertion-failed', 'infrastructure-error', 'cancelled', 'timed-out', 'interrupted'].includes(String(manifest.status))) continue
    if (summary.latestRun && summary.latestRun.at >= manifest.startedAt) continue
    summary.latestRun = { runId, at: manifest.startedAt, status: manifest.status === 'running' ? 'unknown' : String(manifest.status),
      reportUrl: `/devflow/reports/${encodeURIComponent(sessionId)}/${runId}/test-report.md` }
    // A historical run's model remains meaningful even after session model selection changes.
    if (!summary.preflight) summary.model = identity.model
  }
  return summary.preflight || summary.latestRun ? summary : undefined
}

export function registerSummary(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.provide('devflowMidsceneSummary', {
    async read(sessionId: string, cardId: string): Promise<MidsceneSummary> {
      const id = SessionId(sessionId)
      const owner = ctx.get('agents')?.get(id)
      const header = ctx.get('sessions')?.get(id)?.header ?? (await ctx.get('sessionPersistence')?.stat(id))?.header ?? owner?.session.header
      if (!header?.cwd) throw new Error('Unknown session workspace')
      const workspace = await realpath(header.cwd)
      const profiles: ProfileSummary[] = []
      for (const [name, p] of Object.entries(config.profiles)) {
        let legacyWorkspace: string
        try { legacyWorkspace = await realpath(p.workspace) } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') continue
          throw error
        }
        if (legacyWorkspace === workspace) profiles.push(await profileSummary(p, name, workspace, sessionId, cardId))
      }
      const reports = ctx.get('devflowMidsceneReports')
      if (reports) {
        const project = await projectSummary(await reports.output(workspace), workspace, sessionId, cardId)
        if (project) profiles.push(project)
      }
      const jobs = owner ? ctx.get('jobs')?.list(owner).filter(job => job.kind === 'midscene').map(job => ({ id: job.id, status: job.status })) ?? [] : []
      return { available: true, profiles, jobs, gateEngineAvailable: Boolean(ctx.get('devflowValidators')) }
    },
  }))
}
