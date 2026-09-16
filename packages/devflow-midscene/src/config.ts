/** Deployment-owned profiles bind browser work to one canonical workspace. */
import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export interface AcceptanceProfile {
  /** DSH model dispatch is resolved for one job; absent selects a legacy endpoint. */
  modelSource?: 'dsh'
  projectSettingsHash?: string
  /** Diagnostic-only metadata; execution still enforces required login before creating a job. */
  loginPreparation?: { required: boolean; status: 'available' | 'missing' | 'invalid' }
  workspace: string
  output: string
  model: string
  family: string
  baseUrl: string
  provider?: string
  credentialRef?: string
  credentialRecord?: string
  targetUrl: string
  /** Harness report host; omitted leaves explicit local file links. */
  reportBaseUrl?: string
  browserMode: 'puppeteer' | 'cdp' | 'bridge'
  cdpEndpoint?: string
  executablePath?: string
  suite?: string
  suiteSha256?: string
  buildId?: string
  storageState?: string
  deploymentRecord?: string
  timeoutMs: number
  cleanupTimeoutMs: number
  maxSteps: number
}
export interface Config { profiles: Record<string, AcceptanceProfile> }
export type AcceptanceProfileInput = Omit<AcceptanceProfile, 'browserMode' | 'timeoutMs' | 'cleanupTimeoutMs' | 'maxSteps'>
  & Partial<Pick<AcceptanceProfile, 'browserMode' | 'timeoutMs' | 'cleanupTimeoutMs' | 'maxSteps'>>
export interface ConfigInput { profiles?: Record<string, AcceptanceProfileInput> }
export const Config: z<ConfigInput, Config> = z.object({
  profiles: z.dict(z.object({
    workspace: z.string().required(), output: z.string().required(),
    model: z.string().required(), family: z.string().required(), baseUrl: z.string().required(),
    provider: z.string(), credentialRef: z.string(), credentialRecord: z.string(),
    targetUrl: z.string().required(), reportBaseUrl: z.string(),
    browserMode: z.union(['puppeteer', 'cdp', 'bridge']).default('puppeteer'),
    cdpEndpoint: z.string(), executablePath: z.string(),
    suite: z.string(), suiteSha256: z.string(), buildId: z.string(),
    storageState: z.string(), deploymentRecord: z.string(),
    timeoutMs: z.natural().min(1).default(180_000),
    cleanupTimeoutMs: z.natural().min(1).default(10_000),
    maxSteps: z.natural().min(1).default(30),
  })).default({}),
})

/** Reject ambiguous identity and secret-bearing endpoints before registration. */
export function validateProfiles(config: Config): void {
  for (const [name, p] of Object.entries(config.profiles)) {
    if (name === 'project' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Midscene profile names must be lowercase identifiers other than project')
    for (const path of [p.workspace, p.output, p.storageState, p.deploymentRecord, p.executablePath])
      if (path !== undefined && !isAbsolute(path)) throw new Error('Midscene profile paths must be absolute')
    if (resolve(p.workspace) === resolve(p.output)) throw new Error('Midscene output must be outside workspace')
    for (const raw of [p.baseUrl, p.targetUrl, ...p.reportBaseUrl === undefined ? [] : [p.reportBaseUrl]]) {
      const url = new URL(raw)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('Midscene URLs must be HTTP URLs without credentials, query or fragment')
    }
    if (Boolean(p.credentialRef) === Boolean(p.credentialRecord))
      throw new Error('Choose exactly one Midscene credentialRef or credentialRecord')
    if (p.credentialRef && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.credentialRef)) throw new Error('Invalid credentialRef')
    if (p.credentialRecord && !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(p.credentialRecord)) throw new Error('Invalid credentialRecord')
    if (p.browserMode === 'cdp') {
      if (!p.cdpEndpoint) throw new Error('CDP requires an explicit endpoint')
      const endpoint = new URL(p.cdpEndpoint)
      if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new Error('CDP endpoint must be a WebSocket URL without credentials')
    } else if (p.cdpEndpoint) throw new Error('cdpEndpoint requires CDP mode')
    if (p.suiteSha256 && !/^[a-f0-9]{64}$/.test(p.suiteSha256)) throw new Error('Invalid approved suite SHA256')
    for (const value of [p.model, p.family]) if (!value.trim() || /[\r\n]/.test(value)) throw new Error('Model identity must be a single nonempty line')
  }
}
