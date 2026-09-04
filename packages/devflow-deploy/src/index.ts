/**
 * Persistent deployment over the DeepSeek Harness: a declarative `deploy.yml`
 * names what this project publishes, drivers registered per target `kind`
 * execute it, and the `deploy_*` tools drive them. What a deploy leaves behind
 * outlives the session — the opposite promise from a test environment, and the
 * reason nothing on the far side is ever registered as an effect.
 *
 * The plugin stays an executor: phases, deadlines, and failure attribution are
 * mechanical, and interpreting a failure belongs to the model. Named exports
 * preserve loader injection metadata.
 * @module @zhchxiao123/dsh-devflow-deploy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createServiceDriver } from './drivers/service/driver.ts'
import { createStaticDriver } from './drivers/static/driver.ts'
import { DeployEngine } from './engine.ts'
import { MANIFEST_FILENAME } from './manifest.ts'
import { DriverRegistry } from './registry.ts'
import { registerSkill } from './skill.ts'
import { registerTools } from './tools.ts'

export { DeployEngine } from './engine.ts'
export { ManifestError, loadManifest, parseManifest } from './manifest.ts'
export { DriverRegistry, RollbackUnsupportedError, UnknownKindError } from './registry.ts'
export { DeployFailure } from './run.ts'
export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'deploy'

/** Services the engine, tools, and bundled skill register against. */
export const inject = ['tools', 'subprocess', 'skills']

/** The `service` kind's share of the configuration: one compose project. */
export interface ServiceConfig {
  /** Compose project directory on the host; its `.env` is the pointer this kind owns. */
  composeDir: string
  /** Environment variable the compose file interpolates as the image tag. */
  tagVarName?: string
  /** Where a transferred image archive lands before it is loaded. */
  remoteTmpDir?: string
  /** Release images kept per target; the current one and its predecessor are never pruned. */
  keepImages?: number
  /** How long to wait for a new container to report ready. */
  verifyTimeoutMs?: number
  /** Delay between readiness attempts. */
  readyPollIntervalMs?: number
}

/** The `static` kind's share of the configuration: one server's web layout. */
export interface StaticConfig {
  /** Directory the web server serves; one symlink per target is created in it. */
  remoteWebRoot: string
  /** Where release payloads land. Must sit outside the served tree. */
  remoteReleasesRoot: string
  /** URL prefix corresponding to `remoteWebRoot`. */
  baseUrl: string
  /** Release directories kept per target; the current one and its predecessor are never pruned. */
  keepReleases?: number
}

/**
 * Plugin-level tunables. The manifest is project knowledge and lives in the
 * repository; everything that names one server's layout lives here.
 *
 * `drivers` holds one section per target kind, and the core does not know
 * their shapes — a kind validates its own section, exactly as it validates its
 * own manifest fields. Kinds do not share a remote layout (a static site is
 * addressed by a served directory and a URL, a container by a compose
 * project), so there is nothing to hoist. `host` and the execution deadlines
 * are shared, because every kind reaches the same machine the same way.
 *
 * Address fields have no defaults. A guessed remote path is the worst kind of
 * default — it would let a misconfigured composition publish somewhere nobody
 * is looking — so an incomplete section fails at load.
 *
 * No credential appears here. SSH authentication belongs to the machine the
 * harness runs on; this plugin holds no key material and validates none.
 */
export interface Config {
  /** SSH destination: a `~/.ssh/config` host alias, or `user@host`. */
  host: string
  /** One section per configured kind; an unconfigured kind registers no driver. */
  drivers?: Record<string, unknown>
  /** Manifest path, relative to the workspace root. */
  manifestPath?: string
  /** Deadline for a target's declared build command. */
  buildTimeoutMs?: number
  /** Deadline for one remote command. */
  remoteTimeoutMs?: number
  /** In-memory tail cap per captured stream, in bytes. */
  logTailBytes?: number
  /** SIGTERM-to-SIGKILL escalation grace handed to every spawn. */
  graceMs?: number
}

/** Schemastery validator supplying the execution defaults. */
export const Config: z<Config, Required<Config>> = z.object({
  host: z.string().required(),
  drivers: z.dict(z.any()).default({}),
  manifestPath: z.string().default(MANIFEST_FILENAME),
  buildTimeoutMs: z.natural().min(1).default(600_000),
  remoteTimeoutMs: z.natural().min(1).default(120_000),
  logTailBytes: z.natural().min(1).default(65_536),
  graceMs: z.natural().min(1).default(5_000),
})

/** Kinds this package ships a driver for; a section naming anything else fails loud. */
const CONFIGURABLE_KINDS = ['static', 'service'] as const

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/'
}

function requiredString(section: Record<string, unknown>, field: string, kind: string): string {
  const value = section[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`drivers.${kind}.${field} must be a non-empty string`)
  }
  return value
}

function optionalString(section: Record<string, unknown>, field: string, kind: string): string | undefined {
  const value = section[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`drivers.${kind}.${field} must be a non-empty string when present`)
  }
  return value
}

function positiveInteger(section: Record<string, unknown>, field: string, kind: string): number | undefined {
  const value = section[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`drivers.${kind}.${field} must be a positive integer; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate and normalise the `static` section. The core hands it over
 * unexamined, so this is where its shape is checked — the same division the
 * manifest follows, where a kind owns the fields the core does not know.
 *
 * The releases root must sit outside the served tree: payloads inside it would
 * publish every superseded version alongside the current one, and leaving that
 * to the operator's web-server configuration makes the isolation implicit.
 * @param raw - the section as configured.
 * @returns the section with defaults applied and paths normalised.
 * @throws {Error} naming the field that is unusable and why.
 */
export function resolveStaticConfig(raw: unknown): Required<StaticConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('drivers.static must be a mapping naming where static targets are published')
  }
  const section = raw as Record<string, unknown>
  const remoteWebRoot = trimTrailingSlash(requiredString(section, 'remoteWebRoot', 'static'))
  const remoteReleasesRoot = trimTrailingSlash(requiredString(section, 'remoteReleasesRoot', 'static'))
  const baseUrl = trimTrailingSlash(requiredString(section, 'baseUrl', 'static'))
  for (const [field, value] of [['remoteWebRoot', remoteWebRoot], ['remoteReleasesRoot', remoteReleasesRoot]] as const) {
    if (!value.startsWith('/')) {
      throw new Error(`drivers.static.${field} must be an absolute path on the deployment host; got '${value}'`)
    }
  }
  if (!/^https?:\/\/\S+$/.test(baseUrl)) {
    throw new Error(`drivers.static.baseUrl must be an absolute http(s) URL; got '${baseUrl}'`)
  }
  if (remoteReleasesRoot === remoteWebRoot || remoteReleasesRoot.startsWith(`${remoteWebRoot}/`)) {
    throw new Error(
      `drivers.static.remoteReleasesRoot ('${remoteReleasesRoot}') must sit outside remoteWebRoot ('${remoteWebRoot}'): `
      + 'release payloads inside the served tree would publish every superseded version alongside the current one',
    )
  }
  return {
    remoteWebRoot,
    remoteReleasesRoot,
    baseUrl,
    keepReleases: positiveInteger(section, 'keepReleases', 'static') ?? 5,
  }
}

/**
 * Validate and default the `service` section.
 * @param raw - the section as configured.
 * @returns the section with defaults applied and the compose directory normalised.
 * @throws {Error} naming the field that is unusable and why.
 */
export function resolveServiceConfig(raw: unknown): Required<ServiceConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('drivers.service must be a mapping naming the compose project services are published into')
  }
  const section = raw as Record<string, unknown>
  const composeDir = trimTrailingSlash(requiredString(section, 'composeDir', 'service'))
  if (!composeDir.startsWith('/')) {
    throw new Error(`drivers.service.composeDir must be an absolute path on the deployment host; got '${composeDir}'`)
  }
  const tagVarName = optionalString(section, 'tagVarName', 'service') ?? 'APP_IMAGE_TAG'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tagVarName)) {
    throw new Error(`drivers.service.tagVarName must be a shell environment variable name; got '${tagVarName}'`)
  }
  return {
    composeDir,
    tagVarName,
    remoteTmpDir: trimTrailingSlash(optionalString(section, 'remoteTmpDir', 'service') ?? '/tmp'),
    keepImages: positiveInteger(section, 'keepImages', 'service') ?? 5,
    verifyTimeoutMs: positiveInteger(section, 'verifyTimeoutMs', 'service') ?? 120_000,
    readyPollIntervalMs: positiveInteger(section, 'readyPollIntervalMs', 'service') ?? 2_000,
  }
}

/**
 * Refuse a composition that configures no kind, or one this package cannot
 * serve. Loading with neither would leave the tools rejecting every target as
 * an unknown kind, which reads as a defect in the manifest rather than in the
 * configuration.
 * @param drivers - the configured sections.
 * @throws {Error} naming the kinds this package ships.
 */
function assertConfiguredKinds(drivers: Record<string, unknown>): void {
  const names = Object.keys(drivers)
  if (names.length === 0) {
    throw new Error(
      'deploy is configured with no target kinds: add a \'drivers\' section for one of '
      + `${CONFIGURABLE_KINDS.join(', ')}, or remove the plugin from the composition`,
    )
  }
  for (const name of names) {
    if (!CONFIGURABLE_KINDS.includes(name as typeof CONFIGURABLE_KINDS[number])) {
      throw new Error(`drivers.${name}: this package ships no driver for that kind; configurable kinds: ${CONFIGURABLE_KINDS.join(', ')}`)
    }
  }
}

/**
 * Apply the plugin: register the three `deploy_*` tools over a lazily-built map
 * of one {@link DeployEngine} per workspace root, register the `static` driver
 * on this composition's registry, and register the bundled `deploy-bootstrap`
 * skill. The tools resolve the root per call from the calling agent session's
 * working directory, so one long-lived harness serves many project workspaces.
 *
 * Every registration here is an effect, and none of them describes remote
 * state: disposing this fiber removes the tools, the driver, and the skill, and
 * leaves everything already published exactly where it is.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Required<Config>): void {
  assertConfiguredKinds(config.drivers)
  const registry = new DriverRegistry()
  const staticSection = config.drivers['static']
  if (staticSection !== undefined) {
    const resolved = resolveStaticConfig(staticSection)
    ctx.effect(() => registry.register(createStaticDriver({ host: config.host, ...resolved })))
  }
  const serviceSection = config.drivers['service']
  if (serviceSection !== undefined) {
    const resolved = resolveServiceConfig(serviceSection)
    ctx.effect(() => registry.register(createServiceDriver({ host: config.host, ...resolved })))
  }

  const engines = new Map<string, DeployEngine>()
  registerTools(ctx, (root) => {
    let engine = engines.get(root)
    if (engine === undefined) {
      engine = new DeployEngine(ctx, { ...config, root, clock: () => new Date() }, registry)
      engines.set(root, engine)
    }
    return engine
  })
  registerSkill(ctx)
}
