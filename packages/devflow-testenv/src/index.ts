/**
 * Integration-test environment orchestration over the DeepSeek Harness: a
 * declarative `testenv.yml` names the services, their readiness probes, and
 * the test command; deterministic `env_*` / `integration_test` tools execute
 * it through `ctx.subprocess`; a bundled bootstrap skill owns writing and
 * repairing the manifest. The plugin stays an executor — declaration order is
 * the start order, failures carry log tails, and interpretation belongs to
 * the model. Named exports preserve loader injection metadata.
 * @module @zhchxiao123/dsh-devflow-testenv
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TestenvEngine } from './engine.ts'
import { registerSkill } from './skill.ts'
import { registerTools } from './tools.ts'

export { loadManifest, ManifestError, parseManifest } from './manifest.ts'
export { commandProbe, httpProbe, pollUntilReady, tcpProbe } from './probes.ts'
export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'testenv'

/** Services the engine, tools, and bundled skill register against. */
export const inject = ['tools', 'subprocess', 'skills']

/**
 * Plugin-level tunables. The manifest is project knowledge and lives in the
 * repository; everything deployment-varying about executing it lives here.
 */
export interface Config {
  /** Manifest path, relative to the workspace root. */
  manifestPath?: string
  /** Delay between readiness attempts, in milliseconds. */
  readyPollIntervalMs?: number
  /** Readiness deadline for a service that declares none of its own. */
  defaultReadyTimeoutMs?: number
  /** Deadline for a `down` command and for awaiting a terminated tree's exit. */
  downTimeoutMs?: number
  /** Deadline for the seed and test commands. */
  testTimeoutMs?: number
  /** In-memory tail cap per captured stream, in bytes. */
  logTailBytes?: number
  /** SIGTERM-to-SIGKILL escalation grace handed to every spawn. */
  graceMs?: number
}

/** Schemastery validator supplying the execution defaults. */
export const Config: z<Config, Required<Config>> = z.object({
  manifestPath: z.string().default('testenv.yml'),
  readyPollIntervalMs: z.natural().min(1).default(500),
  defaultReadyTimeoutMs: z.natural().min(1).default(60_000),
  downTimeoutMs: z.natural().min(1).default(30_000),
  testTimeoutMs: z.natural().min(1).default(600_000),
  logTailBytes: z.natural().min(1).default(65_536),
  graceMs: z.natural().min(1).default(5_000),
})

/**
 * Apply the plugin: construct the single environment engine, register the
 * five `env_*` / `integration_test` tools, and register the bundled
 * `testenv-bootstrap` skill provider. The workspace root is the process cwd
 * at apply time — the harness runs with its cwd at the workspace root, the
 * same assumption devflow-filesystem's default root rests on — and every
 * manifest path and service cwd resolves against that captured root.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Required<Config>): void {
  const engine = new TestenvEngine(ctx, { ...config, root: resolve('.') })
  registerTools(ctx, engine)
  registerSkill(ctx)
}
