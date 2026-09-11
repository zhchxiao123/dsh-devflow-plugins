/**
 * Loading and validation of the project manifest (`testenv.yml` by default) —
 * this plugin's durable/file boundary. The whole file is validated in one
 * pass and every defect is reported at once with its field path, because the
 * reader of a manifest error is whoever must fix the file. The reserved
 * `kind: 'static'` gets its own error, distinct from an unknown value: the
 * field is legal vocabulary that is not implemented yet.
 */

import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ReadinessSpec, ReportFormat, ReportSpec, ServiceSpec, TestenvManifest } from './types.ts'

/** Every manifest defect of one load, each carrying its field path. */
export class ManifestError extends Error {
  /** One line per defect, in document order. */
  readonly issues: readonly string[]

  constructor(path: string, issues: readonly string[]) {
    super(`testenv manifest ${path} is invalid:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
    this.name = 'ManifestError'
    this.issues = issues
  }
}

const MANIFEST_KEYS = ['services', 'seed', 'test', 'evidence', 'report'] as const
const REPORT_KEYS = ['path', 'format'] as const
const REPORT_FORMATS: readonly ReportFormat[] = ['playwright-json', 'junit']
const SERVICE_KEYS = ['name', 'kind', 'up', 'ready', 'down', 'env', 'cwd', 'readyTimeoutMs'] as const
const READY_KEYS = ['tcp', 'http', 'command'] as const
const TCP_KEYS = ['port', 'host'] as const
const HTTP_KEYS = ['url', 'status'] as const
const COMMAND_KEYS = ['run'] as const

/**
 * Read and validate one manifest file.
 * @param path - absolute manifest path; the engine resolves it against the caller's workspace root.
 * @returns the validated, normalized manifest.
 * @throws {ManifestError} for an unreadable file or any validation defect.
 */
export async function loadManifest(path: string): Promise<TestenvManifest> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    throw new ManifestError(path, [`the manifest file cannot be read (${message(error)})`])
  }
  return parseManifest(raw, path)
}

/**
 * Validate one manifest document. Defaults are settled here: `kind` to
 * `'process'` and a tcp probe's `host` to `127.0.0.1`.
 * @param raw - the manifest text.
 * @param path - where the text came from, for the error header.
 * @returns the validated, normalized manifest.
 * @throws {ManifestError} listing every defect with its field path.
 */
export function parseManifest(raw: string, path: string): TestenvManifest {
  let data: unknown
  try {
    data = parseYaml(raw)
  } catch (error) {
    throw new ManifestError(path, [`the manifest is not parseable YAML: ${message(error)}`])
  }
  const issues: string[] = []
  const manifest = validatedManifest(data, issues)
  if (manifest === undefined) throw new ManifestError(path, issues)
  if (issues.length > 0) throw new ManifestError(path, issues)
  return manifest
}

/** The root document; `undefined` only when the root itself is not a mapping. */
function validatedManifest(data: unknown, issues: string[]): TestenvManifest | undefined {
  if (!isMapping(data)) {
    issues.push('the manifest root must be a YAML mapping')
    return undefined
  }
  issues.push(...unknownKeyIssues(data, MANIFEST_KEYS, 'manifest'))
  const services = validatedServices(data.services, issues)
  const seed = optionalString(data.seed, 'seed', issues)
  const test = requiredString(data.test, 'test', issues)
  const evidence = validatedEvidence(data.evidence, issues)
  const report = validatedReport(data.report, issues)
  return {
    services,
    ...seed === undefined ? {} : { seed },
    test,
    ...evidence === undefined ? {} : { evidence },
    ...report === undefined ? {} : { report },
  }
}

/** Evidence globs: one string or a list of them, each contained by the workspace root. */
function validatedEvidence(value: unknown, issues: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const single = containedPath(value, 'evidence', issues)
    return single === undefined ? undefined : [single]
  }
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('evidence must be a glob string, or a list of at least one glob')
    return undefined
  }
  const globs: string[] = []
  for (const [index, entry] of value.entries()) {
    const glob = containedPath(entry, `evidence[${index}]`, issues)
    if (glob !== undefined) globs.push(glob)
  }
  return globs.length === 0 ? undefined : globs
}

/** The machine-readable report declaration: where the file is, and which parser reads it. */
function validatedReport(value: unknown, issues: string[]): ReportSpec | undefined {
  if (value === undefined) return undefined
  if (!isMapping(value)) {
    issues.push('report must be a mapping with a path and a format')
    return undefined
  }
  issues.push(...unknownKeyIssues(value, REPORT_KEYS, 'report'))
  const path = containedPath(value.path, 'report.path', issues)
  const format = validatedReportFormat(value.format, issues)
  if (path === undefined || format === undefined) return undefined
  return { path, format }
}

/** The parser tag; every legal value is implemented, so an unknown one has one error. */
function validatedReportFormat(value: unknown, issues: string[]): ReportFormat | undefined {
  if (typeof value === 'string' && (REPORT_FORMATS as readonly string[]).includes(value)) {
    return value as ReportFormat
  }
  issues.push(`report.format must be one of ${REPORT_FORMATS.map(format => JSON.stringify(format)).join(', ')}`)
  return undefined
}

/**
 * A non-empty relative path or glob that stays inside the workspace root.
 * Escape is a load-time defect rather than a read-time surprise: the tools
 * resolve these against the calling session's root, and a pattern reaching
 * outside it would read files the workspace never offered.
 */
function containedPath(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`)
    return undefined
  }
  if (posix.isAbsolute(value) || posix.normalize(value).startsWith('..')) {
    issues.push(`${path} must stay inside the workspace root (no absolute paths, no '..' segments)`)
    return undefined
  }
  return value
}

/** The ordered service list; declaration order is the start order. */
function validatedServices(value: unknown, issues: string[]): ServiceSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('services must be a list with at least one service')
    return []
  }
  const seen = new Map<string, number>()
  const services: ServiceSpec[] = []
  for (const [index, entry] of value.entries()) {
    const service = validatedService(entry, index, seen, issues)
    if (service !== undefined) services.push(service)
  }
  return services
}

/** One service entry; `undefined` when it cannot be assembled at all. */
function validatedService(
  entry: unknown,
  index: number,
  seen: Map<string, number>,
  issues: string[],
): ServiceSpec | undefined {
  const path = `services[${index}]`
  if (!isMapping(entry)) {
    issues.push(`${path} must be a mapping`)
    return undefined
  }
  issues.push(...unknownKeyIssues(entry, SERVICE_KEYS, path))
  const name = requiredString(entry.name, `${path}.name`, issues)
  if (name !== '') {
    const first = seen.get(name)
    if (first === undefined) seen.set(name, index)
    else issues.push(`${path}.name duplicates services[${first}].name (${JSON.stringify(name)}); service names must be unique`)
  }
  if (entry.kind === 'static') {
    // Reserved, not unknown: the vocabulary exists for future static preview
    // hosting, and this error must stay distinguishable from a typo. Preview
    // hosting is session-scoped and torn down with the environment; publishing
    // a site that outlives the session is a different capability and lives in
    // `@zhchxiao123/dsh-devflow-deploy`, whose own `static` target kind shares
    // the name but promises the opposite lifecycle.
    issues.push(`${path}.kind: 'static' services are reserved for future static preview hosting and are not implemented yet; run the service as a 'process' or remove it`)
  } else if (entry.kind !== undefined && entry.kind !== 'process') {
    issues.push(`${path}.kind must be 'process' when present ('static' is reserved but not implemented)`)
  }
  const up = requiredString(entry.up, `${path}.up`, issues)
  const ready = validatedReady(entry.ready, `${path}.ready`, issues)
  const down = optionalString(entry.down, `${path}.down`, issues)
  const env = validatedEnv(entry.env, `${path}.env`, issues)
  const cwd = optionalString(entry.cwd, `${path}.cwd`, issues)
  const readyTimeoutMs = validatedTimeout(entry.readyTimeoutMs, `${path}.readyTimeoutMs`, issues)
  if (ready === undefined) return undefined
  return {
    name,
    kind: 'process',
    up,
    ready,
    ...down === undefined ? {} : { down },
    ...env === undefined ? {} : { env },
    ...cwd === undefined ? {} : { cwd },
    ...readyTimeoutMs === undefined ? {} : { readyTimeoutMs },
  }
}

/** The readiness declaration: a mapping with exactly one probe key. */
function validatedReady(value: unknown, path: string, issues: string[]): ReadinessSpec | undefined {
  if (!isMapping(value)) {
    issues.push(`${path} is required and must be a mapping declaring exactly one probe: tcp, http, or command`)
    return undefined
  }
  issues.push(...unknownKeyIssues(value, READY_KEYS, path))
  const declared = READY_KEYS.filter(key => value[key] !== undefined)
  if (declared.length !== 1) {
    issues.push(`${path} must declare exactly one probe: tcp, http, or command`)
    return undefined
  }
  if (value.tcp !== undefined) return validatedTcp(value.tcp, `${path}.tcp`, issues)
  if (value.http !== undefined) return validatedHttp(value.http, `${path}.http`, issues)
  return validatedCommand(value.command, `${path}.command`, issues)
}

/** The tcp probe: a port, and a host defaulting to loopback. */
function validatedTcp(value: unknown, path: string, issues: string[]): ReadinessSpec | undefined {
  if (!isMapping(value)) {
    issues.push(`${path} must be a mapping with a port and an optional host`)
    return undefined
  }
  issues.push(...unknownKeyIssues(value, TCP_KEYS, path))
  const port = validatedPort(value.port, `${path}.port`, issues)
  let host = '127.0.0.1'
  let hostValid = true
  if (value.host !== undefined) {
    if (typeof value.host === 'string' && value.host.trim().length > 0) {
      host = value.host
    } else {
      issues.push(`${path}.host must be a non-empty string when present`)
      hostValid = false
    }
  }
  if (port === undefined || !hostValid) return undefined
  return { probe: 'tcp', tcp: { host, port } }
}

/** The http probe: an absolute http:// URL and an optional exact status. */
function validatedHttp(value: unknown, path: string, issues: string[]): ReadinessSpec | undefined {
  if (!isMapping(value)) {
    issues.push(`${path} must be a mapping with a url and an optional status`)
    return undefined
  }
  issues.push(...unknownKeyIssues(value, HTTP_KEYS, path))
  const url = validatedUrl(value.url, `${path}.url`, issues)
  const status = validatedStatus(value.status, `${path}.status`, issues)
  if (url === undefined) return undefined
  return { probe: 'http', http: { url, ...status === undefined ? {} : { status } } }
}

/** The command probe: a shell command whose exit 0 means ready. */
function validatedCommand(value: unknown, path: string, issues: string[]): ReadinessSpec | undefined {
  if (!isMapping(value)) {
    issues.push(`${path} must be a mapping with a run command`)
    return undefined
  }
  issues.push(...unknownKeyIssues(value, COMMAND_KEYS, path))
  const run = requiredString(value.run, `${path}.run`, issues)
  if (run === '') return undefined
  return { probe: 'command', command: { run } }
}

/** A mapping in the YAML sense: an object that is not a sequence. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One issue per key outside the schema, so a typo names itself. */
function unknownKeyIssues(value: Record<string, unknown>, known: readonly string[], path: string): string[] {
  return Object.keys(value)
    .filter(key => !known.includes(key))
    .map(key => `${path} has unknown key ${JSON.stringify(key)}`)
}

/** A required non-empty string; an invalid value settles to `''` behind its issue. */
function requiredString(value: unknown, path: string, issues: string[]): string {
  if (typeof value === 'string' && value.trim().length > 0) return value
  issues.push(`${path} must be a non-empty string`)
  return ''
}

/** An optional non-empty string; absence is legal, an invalid value is an issue. */
function optionalString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined
  const settled = requiredString(value, path, issues)
  return settled === '' ? undefined : settled
}

/** An optional mapping of environment entries, every value a string. */
function validatedEnv(value: unknown, path: string, issues: string[]): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isMapping(value)) {
    issues.push(`${path} must be a mapping of variable names to string values`)
    return undefined
  }
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') env[key] = entry
    else issues.push(`${path}.${key} must be a string`)
  }
  return env
}

/** A TCP port: an integer in 1..65535. */
function validatedPort(value: unknown, path: string, issues: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    issues.push(`${path} must be an integer between 1 and 65535`)
    return undefined
  }
  return value
}

/**
 * An absolute `http://` URL. `https:` is rejected on purpose: local readiness
 * endpoints are served plain, and probing a self-signed dev certificate would
 * force a verification-policy decision no current owner needs.
 */
function validatedUrl(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value === 'string' && parsedUrl(value)?.protocol === 'http:') return value
  issues.push(`${path} must be an absolute http:// URL (https readiness probing is not supported)`)
  return undefined
}

/** The URL, or `undefined` for a string the constructor refuses. */
function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    // Swallows the URL constructor's TypeError for a malformed string; the
    // caller reports the field path, which is the actionable fact.
    return undefined
  }
}

/** An optional exact HTTP status: an integer in 100..599. */
function validatedStatus(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    issues.push(`${path} must be an integer HTTP status between 100 and 599`)
    return undefined
  }
  return value
}

/** An optional positive integer of milliseconds. */
function validatedTimeout(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    issues.push(`${path} must be a positive integer of milliseconds`)
    return undefined
  }
  return value
}

function message(error: unknown): string {
  /* v8 ignore next -- readFile and yaml throw Error instances; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}
