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

/**
 * Plugin-level tunables. The manifest is project knowledge and lives in the
 * repository; everything that names one server's layout lives here.
 *
 * The four address fields have no defaults on purpose. A guessed remote path
 * is the worst kind of default — it would let a misconfigured composition
 * publish somewhere nobody is looking — so an incomplete configuration fails
 * at load instead.
 *
 * No credential appears here. SSH authentication belongs to the machine the
 * harness runs on; this plugin holds no key material and validates none.
 */
export interface Config {
  /** SSH destination: a `~/.ssh/config` host alias, or `user@host`. */
  host: string
  /** Directory the web server serves; one symlink per target is created in it. */
  remoteWebRoot: string
  /** Where release payloads land. Must sit outside the served tree. */
  remoteReleasesRoot: string
  /** URL prefix corresponding to `remoteWebRoot`. */
  baseUrl: string
  /** Manifest path, relative to the workspace root. */
  manifestPath?: string
  /** Release directories kept per target; the current one and its predecessor are never pruned. */
  keepReleases?: number
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
  remoteWebRoot: z.string().required(),
  remoteReleasesRoot: z.string().required(),
  baseUrl: z.string().required(),
  manifestPath: z.string().default(MANIFEST_FILENAME),
  keepReleases: z.natural().min(1).default(5),
  buildTimeoutMs: z.natural().min(1).default(600_000),
  remoteTimeoutMs: z.natural().min(1).default(120_000),
  logTailBytes: z.natural().min(1).default(65_536),
  graceMs: z.natural().min(1).default(5_000),
})

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/'
}

/**
 * Check the address fields against each other and normalise their trailing
 * slashes. Schemastery types and defaults each field alone; the relations
 * between them are checked here, at load, because a composition that names an
 * unusable server should never reach a first deploy.
 *
 * The releases root must sit outside the served tree: payloads inside it would
 * publish every superseded version alongside the current one, and leaving that
 * to the operator's web-server configuration makes the isolation implicit.
 * @param config - the validated configuration.
 * @returns the configuration with normalised paths.
 * @throws {Error} naming the field that is unusable and why.
 */
export function resolveAddresses(config: Required<Config>): Required<Config> {
  for (const field of ['remoteWebRoot', 'remoteReleasesRoot'] as const) {
    if (!config[field].startsWith('/')) {
      throw new Error(`${field} must be an absolute path on the deployment host; got '${config[field]}'`)
    }
  }
  if (!/^https?:\/\/\S+$/.test(config.baseUrl)) {
    throw new Error(`baseUrl must be an absolute http(s) URL; got '${config.baseUrl}'`)
  }
  const remoteWebRoot = trimTrailingSlash(config.remoteWebRoot)
  const remoteReleasesRoot = trimTrailingSlash(config.remoteReleasesRoot)
  if (remoteReleasesRoot === remoteWebRoot || remoteReleasesRoot.startsWith(`${remoteWebRoot}/`)) {
    throw new Error(
      `remoteReleasesRoot ('${remoteReleasesRoot}') must sit outside remoteWebRoot ('${remoteWebRoot}'): `
      + 'release payloads inside the served tree would publish every superseded version alongside the current one',
    )
  }
  return { ...config, remoteWebRoot, remoteReleasesRoot, baseUrl: trimTrailingSlash(config.baseUrl) }
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
 * @param rawConfig - validated {@link Config}, before the cross-field address checks.
 */
export function apply(ctx: Context, rawConfig: Required<Config>): void {
  const config = resolveAddresses(rawConfig)
  const registry = new DriverRegistry()
  ctx.effect(() => registry.register(createStaticDriver(config)))

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
