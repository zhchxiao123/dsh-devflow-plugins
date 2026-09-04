/**
 * The orchestration between a tool call and a driver: load the manifest,
 * resolve the target's kind through the registry, let that kind's driver
 * validate the fields the core does not own, run the declared build, and hand
 * over. Nothing here names a deployment kind — that is the whole point of the
 * registry sitting between this and the drivers.
 *
 * One engine serves one workspace root. A long-lived harness serves many
 * workspaces, so the plugin keeps one engine per root rather than one per
 * process.
 */

import { loadManifest, requireTarget } from './manifest.ts'
import { DeployRunContext, shellArgv } from './run.ts'
import type { RunHost, RunSettings } from './run.ts'
import type { DriverEntry, DriverRegistry } from './registry.ts'
import type { DeployOutcome, ManifestTarget, PhaseTiming, TargetStatus } from './types.ts'

/** Everything the engine needs beyond the run's own settings. */
export interface EngineSettings extends RunSettings {
  /** Manifest path, relative to the workspace root. */
  readonly manifestPath: string
  /** Deadline for a target's declared build command. */
  readonly buildTimeoutMs: number
}

/** What one deploy or rollback produced, plus how the run spent its time. */
export interface DeployReport {
  readonly target: string
  readonly kind: string
  readonly outcome: DeployOutcome
  readonly timeline: readonly PhaseTiming[]
  readonly warnings: readonly string[]
  readonly durationMs: number
}

/** What one status call observed. */
export interface StatusReport {
  readonly targets: readonly TargetStatus[]
  readonly durationMs: number
}

function total(timeline: readonly PhaseTiming[]): number {
  return timeline.reduce((sum, entry) => sum + entry.durationMs, 0)
}

/** Drives one workspace's `deploy.yml` through the registered drivers. */
export class DeployEngine {
  private readonly host: RunHost
  private readonly settings: EngineSettings
  private readonly registry: DriverRegistry

  constructor(host: RunHost, settings: EngineSettings, registry: DriverRegistry) {
    this.host = host
    this.settings = settings
    this.registry = registry
  }

  private newRun(): DeployRunContext {
    return new DeployRunContext(this.host, this.settings)
  }

  private async resolve(name: string): Promise<{ target: ManifestTarget; entry: DriverEntry; spec: unknown }> {
    const manifest = await loadManifest(this.settings.root, this.settings.manifestPath)
    return this.bind(requireTarget(manifest, name), name)
  }

  private bind(target: ManifestTarget, name: string): { target: ManifestTarget; entry: DriverEntry; spec: unknown } {
    const entry = this.registry.get(target.kind)
    return { target, entry, spec: entry.validate(target.spec, `targets.${name}`) }
  }

  /**
   * Build the target if it declares a build, then deploy it.
   * @param name - the declared target name.
   * @returns the driver's outcome with the run's timeline and warnings.
   * @throws {ManifestError} when the manifest is missing, invalid, or declares no such target.
   * @throws {UnknownKindError} when no driver is registered for the target's kind.
   * @throws {DeployFailure} when a phase fails.
   */
  async deploy(name: string): Promise<DeployReport> {
    const run = this.newRun()
    const { target, entry, spec } = await this.resolve(name)
    if (target.build !== undefined) {
      run.phase('build')
      await run.mustExec(shellArgv(target.build), { timeoutMs: this.settings.buildTimeoutMs })
    }
    const outcome = await entry.deploy(run, name, spec)
    return this.report(name, target.kind, outcome, run)
  }

  /**
   * Return a target to a previous release.
   * @param name - the declared target name.
   * @param to - the release to return to; the one before the current by default.
   * @returns the driver's outcome with the run's timeline and warnings.
   * @throws {RollbackUnsupportedError} when the target's kind promises no rollback.
   */
  async rollback(name: string, to?: string): Promise<DeployReport> {
    const run = this.newRun()
    const { target, entry, spec } = await this.resolve(name)
    const outcome = await entry.rollback(run, name, spec, to)
    return this.report(name, target.kind, outcome, run)
  }

  /**
   * Report the present state of one target, or of every declared target.
   * @param name - one target name, or `undefined` for all of them.
   * @returns each target's status in declaration order.
   */
  async status(name?: string): Promise<StatusReport> {
    const run = this.newRun()
    const manifest = await loadManifest(this.settings.root, this.settings.manifestPath)
    const names = name === undefined ? [...manifest.targets.keys()] : [name]
    const targets: TargetStatus[] = []
    for (const each of names) {
      const { entry, spec } = this.bind(requireTarget(manifest, each), each)
      targets.push(await entry.status(run, each, spec))
    }
    return { targets, durationMs: total(run.timeline()) }
  }

  private report(name: string, kind: string, outcome: DeployOutcome, run: DeployRunContext): DeployReport {
    const timeline = run.timeline()
    return { target: name, kind, outcome, timeline, warnings: run.recordedWarnings(), durationMs: total(timeline) }
  }
}
