/** Versioned suite and finite acceptance evidence shared by the CLI and its isolated browser worker. */
export type Step =
  | { kind: 'goto'; path: string }
  | { kind: 'act' | 'assert'; prompt: string }
  | { kind: 'text'; selector: string; expected: string }

export interface Suite {
  version: 1
  name: string
  baseUrl: string
  buildProbe: { path: string; expected: string; method?: 'GET' | 'POST'; format?: 'text' | 'json'; field?: string[]; instanceField?: string[] }
  cases: { id: string; steps: Step[] }[]
}
export type Outcome =
  'running' | 'passed' | 'assertion-failed' | 'infrastructure-error' | 'cancelled' | 'timed-out' | 'interrupted'
export interface CaseResult {
  id: string
  status: 'passed' | 'assertion-failed' | 'infrastructure-error'
  completedSteps: number
  passedAssertions: number
  report?: string
  screenshot?: string
}
export interface RunManifest {
  version: 1
  runId: string
  card: string
  status: Outcome
  startedAt: string
  endedAt?: string
  identity: {
    workspace: string
    commit: string
    workspaceSha256: string
    suiteSha256: string
    buildId: string
    buildVerified: boolean
    targetInstanceId?: string
    model: string
    midscene: '1.12.6'
    playwright: '1.63.0'
  }
  counts: {
    cases: number
    completedCases: number
    assertions: number
    passedAssertions: number
    steps: number
    completedSteps: number
  }
  results: CaseResult[]
  cleanup: 'pending' | 'confirmed' | 'unknown'
  reason?: string
  usage:
    | 'unavailable'
    | { calls: number; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }
  reports: { markdown: string; html: string; results: string; baseUrl: string }
}
export interface RunOptions {
  environment?: Readonly<Record<string, string>>
  storageState?: string
  deploymentRecord?: string
  suite: string
  workspace: string
  output: string
  card: string
  buildId: string
  model: string
  timeoutMs: number
  maxSteps: number
  cleanupTimeoutMs: number
  executablePath?: string
  reportBaseUrl?: string
  signal?: AbortSignal
  onProgress?: (event: string) => void
}
export interface StorageState {
  cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }[]
  origins: { origin: string; localStorage: { name: string; value: string }[] }[]
}
export interface WorkerInput {
  storageState?: StorageState
  suite: Suite
  runDir: string
  cleanupTimeoutMs: number
  maxSteps: number
  executablePath?: string
}

export interface ExplorationOwnership {
  version: 1
  ownerPid: number
  browserMode: 'puppeteer' | 'cdp' | 'bridge'
  endpoint?: string
  browserPid?: number
  browserExecutable?: string
  commandPid?: number
  commandScript?: string
  browserUserDataDir?: string
}
