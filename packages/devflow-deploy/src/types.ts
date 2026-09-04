/**
 * Types of the target-type seam. A deployment target names a `kind`; a driver
 * registered for that kind owns validating the target's manifest fields and
 * executing it. The core never learns a kind's private vocabulary, so adding a
 * kind is a registration rather than a change here.
 * @module @zhchxiao123/dsh-devflow-deploy/types
 */

/**
 * The closed phase vocabulary every driver reports against. Not every kind
 * uses every phase — a static site has nothing to `verify`, a delegated
 * orchestrator collapses `transfer` into `activate` — but the vocabulary is
 * closed so renders and failure diagnosis carry no per-kind branch.
 *
 * `preflight` is a semantic boundary: a failure at or before it MUST leave the
 * remote side untouched.
 */
export type Phase
  = | 'resolve'
    | 'build'
    | 'preflight'
    | 'transfer'
    | 'activate'
    | 'verify'
    | 'prune'

/**
 * What a driver promises about returning a target to its previous release.
 * Deployment kinds differ here more than anywhere else — a symlink flip is
 * atomic, a container swap has a restart window, and a delegated cluster
 * playbook may not be reversible at all — so the promise is per-driver and
 * queryable rather than uniform. `deploy_status` renders it, which is what
 * lets a caller know before it tries.
 */
export type RollbackClass
  = /** One operation returns the previous release: no interruption, no re-transfer. */
    | { readonly kind: 'atomic' }
    /** Reversible, but the activation flow re-runs and service is interrupted while it does. */
    | { readonly kind: 'disruptive'; readonly note: string }
    /** No rollback is promised. A driver in this class MUST omit `rollback`. */
    | { readonly kind: 'unsupported'; readonly reason: string }

/** Exit facts and captured output of one bounded command. */
export interface ExecResult {
  /** The argv as executed, for verbatim inclusion in failure reports. */
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** Bounded tail of the merged output streams. */
  readonly output: string
  /** True when the process closed with code 0. */
  readonly ok: boolean
  /** True when the run's own deadline terminated the tree. */
  readonly timedOut: boolean
  readonly durationMs: number
}

/** Per-command overrides of the run's defaults. */
export interface ExecOptions {
  /** Working directory, resolved against the workspace root. Defaults to the root. */
  readonly cwd?: string
  /** Deadline for this command. Defaults to the run's remote timeout. */
  readonly timeoutMs?: number
}

/**
 * The execution context the core hands a driver for one tool call. A driver
 * reaches the outside world only through this — it never touches `ctx` — so
 * deadlines, output bounds, and phase attribution stay owned by the core and a
 * driver stays drivable from a test without a container.
 */
export interface DeployRun {
  /** Absolute workspace root, resolved per call from the calling agent session. */
  readonly root: string
  /** Marks the phase subsequent work belongs to; failures inherit the current mark. */
  phase(phase: Phase): void
  /** Run one command to completion under a deadline. Non-zero exit is returned, not thrown. */
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>
  /**
   * Run one command and throw a {@link DeployFailure} tagged with the current
   * phase unless it exits 0.
   */
  mustExec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>
  /**
   * A fresh release identifier. Wall-clock derived on purpose: this is a
   * durable, sortable, human-meaningful name, unlike the monotonic readings
   * every duration in a report is measured with.
   */
  releaseId(): string
  /** Records a non-fatal defect; the report carries it and the deploy still succeeds. */
  warn(message: string): void
}

/** One release known to a driver. */
export interface ReleaseInfo {
  /**
   * Driver-defined and **opaque to the core**: a timestamped directory name for
   * one kind, an image tag for another. The core neither parses it nor assumes
   * it sorts — ordering is whatever the driver returned.
   */
  readonly id: string
  /** True for the release currently serving. */
  readonly current: boolean
}

/** What a driver reports about one target's present state. */
export interface TargetStatus {
  readonly name: string
  readonly kind: string
  readonly rollbackClass: RollbackClass
  /** Where the deployed target can be reached, when the kind has such an address. */
  readonly url?: string
  /** Absent when nothing has been deployed yet. */
  readonly currentRelease?: string
  /** Driver-ordered; the core does not re-sort. */
  readonly releases: readonly ReleaseInfo[]
}

/** What a driver reports after a successful deploy or rollback. */
export interface DeployOutcome {
  readonly releaseId: string
  /** Where the deployed target can now be reached, when the kind has such an address. */
  readonly url?: string
}

/** One target after its driver validated the manifest fields it owns. */
export interface ResolvedTarget<S> {
  readonly name: string
  readonly spec: S
}

/**
 * A deployment kind's implementation.
 *
 * `rollback` is optional, and its absence IS the `unsupported` rollback class —
 * the two are checked against each other at registration, so a driver cannot
 * advertise a rollback it did not implement.
 */
export interface TargetDriver<S> {
  readonly kind: string
  readonly rollbackClass: RollbackClass
  /**
   * Validate the manifest fields this kind owns.
   * @param spec - the target entry, minus the fields the core owns.
   * @param path - field path of this target, for issue messages.
   * @throws {ManifestError} listing every field-path issue found.
   */
  validate(spec: unknown, path: string): S
  deploy(run: DeployRun, target: ResolvedTarget<S>): Promise<DeployOutcome>
  status(run: DeployRun, target: ResolvedTarget<S>): Promise<TargetStatus>
  /**
   * Omit when this kind cannot promise a rollback. Declared as a property
   * rather than a method so the registry can hold it as a value.
   */
  readonly rollback?: (run: DeployRun, target: ResolvedTarget<S>, to?: string) => Promise<DeployOutcome>
}

/** One target as the manifest declares it, before its driver validates it. */
export interface ManifestTarget {
  readonly kind: string
  /** Optional pre-step run before the driver takes over, still within the `build` phase. */
  readonly build?: string
  /** The fields the core does not own, handed to the driver verbatim. */
  readonly spec: Record<string, unknown>
}

/** A parsed `deploy.yml`. */
export interface DeployManifest {
  readonly targets: ReadonlyMap<string, ManifestTarget>
}

/** A phase-tagged report of one deploy, rollback, or status call. */
export interface PhaseTiming {
  readonly phase: Phase
  readonly durationMs: number
}
