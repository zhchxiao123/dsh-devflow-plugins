/**
 * Type vocabulary of the testenv plugin: the validated manifest shape and the
 * probe/runner contracts the engine composes. Runtime code lives beside this
 * file; consumers outside the package read these types through the package
 * root.
 */

import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** TCP readiness: the service is ready once a connection to `host:port` opens. */
export interface TcpProbeSpec {
  /** Address to connect to; the manifest default is `127.0.0.1`. */
  host: string
  /** Port to connect to. */
  port: number
}

/** HTTP readiness: the service is ready once a GET on `url` answers with the wanted status. */
export interface HttpProbeSpec {
  /** Absolute `http://` URL; requests go direct, never through a proxy. */
  url: string
  /** Exact status that counts as ready; omitted means any 2xx. */
  status?: number
}

/** Command readiness: the service is ready once `run` exits 0. */
export interface CommandProbeSpec {
  /** Shell command line; every non-zero exit is "not ready yet", not an error. */
  run: string
}

/** One service's readiness declaration — exactly one probe kind. */
export type ReadinessSpec =
  | { probe: 'tcp'; tcp: TcpProbeSpec }
  | { probe: 'http'; http: HttpProbeSpec }
  | { probe: 'command'; command: CommandProbeSpec }

/** The probe kind a service's readiness declaration selects. */
export type ProbeKind = ReadinessSpec['probe']

/**
 * One validated service of the manifest. `kind` is always `'process'` today:
 * the manifest reserves `'static'` and validation rejects it as unimplemented.
 */
export interface ServiceSpec {
  /** Unique service name; teardown and log reads address services by it. */
  name: string
  /** The only runnable service kind. */
  kind: 'process'
  /** Shell command that starts the service. */
  up: string
  /** Readiness declaration gating the next service's start. */
  ready: ReadinessSpec
  /** Shell command that tears the service down; omitted falls back to tree termination. */
  down?: string
  /** Environment entries layered over the scrubbed parent environment. */
  env?: Record<string, string>
  /** Working directory relative to the workspace root. */
  cwd?: string
  /** Per-service readiness deadline; omitted uses `Config.defaultReadyTimeoutMs`. */
  readyTimeoutMs?: number
}

/** The whole validated manifest; `services` order is the start order. */
export interface TestenvManifest {
  /** Services in declaration order — the order they start, and the reverse of teardown. */
  services: readonly ServiceSpec[]
  /** Shell command run between environment-up and the test command. */
  seed?: string
  /** The integration-test shell command. */
  test: string
}

/**
 * One readiness attempt. A `false` answer means "not ready yet" — including
 * an attempt cut short by the signal; the poller owns cause classification.
 * A rejection is a real defect (a spawn failure, not an unready service) and
 * propagates.
 */
export type ReadinessProbe = (signal: AbortSignal) => Promise<boolean>

/**
 * Runs one fully-specified spawn to completion and reports its exit facts.
 * The spec carries `SubprocessSpawnSpec` semantics unchanged: no defaults,
 * shell interpretation already resolved into `argv`, and the deadline owned
 * by whoever supplies `spec.signal`. The engine backs this with
 * `ctx.subprocess.spawn` + `done`.
 */
export type SpawnRunner = (spec: SubprocessSpawnSpec) => Promise<SubprocessOutcome>

/** A spawn request minus the per-attempt signal the command probe appends. */
export type SpawnPlan = Omit<SubprocessSpawnSpec, 'signal'>

/** Deadline and pacing of one readiness poll; the caller owns both values. */
export interface PollOptions {
  /** Delay between attempts, in milliseconds. */
  intervalMs: number
  /** Overall deadline, in milliseconds, counted from the first attempt. */
  timeoutMs: number
  /** External cancellation, e.g. "the process exited before becoming ready". */
  signal?: AbortSignal
}

/** Settled poll result; an unready outcome names which deadline ended it. */
export type PollOutcome =
  | { ready: true }
  | { ready: false; cause: 'timeout' | 'aborted' }

/** The subprocess surface the engine consumes; `ctx.subprocess` satisfies it. */
export interface SubprocessSpawner {
  /** Start one managed child process from a fully-specified spec. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/**
 * The context surface the engine consumes — a cordis `Context` with the
 * subprocess service loaded satisfies it structurally. `effect` registers the
 * running environment on the owning fiber; the registered disposer is the
 * whole teardown, so a disposed fiber cannot leak service processes.
 */
export interface EngineHost {
  subprocess: SubprocessSpawner
  effect(execute: () => () => Promise<void>, label?: string): () => Promise<void>
}

/** Resolved execution tunables of one engine instance; the caller settles every default. */
export interface EngineSettings {
  /** Absolute workspace root; the manifest path and every service cwd resolve against it. */
  root: string
  /** Manifest path relative to `root`. */
  manifestPath: string
  /** Delay between readiness attempts, in milliseconds. */
  readyPollIntervalMs: number
  /** Readiness deadline for a service that declares none of its own. */
  defaultReadyTimeoutMs: number
  /** Deadline for a `down` command and for awaiting a terminated tree's exit. */
  downTimeoutMs: number
  /** Deadline for the seed and test commands, each. */
  testTimeoutMs: number
  /** In-memory tail cap per captured stream, in bytes. */
  logTailBytes: number
  /** SIGTERM-to-SIGKILL escalation grace handed to every spawn. */
  graceMs: number
}

/** Engine lifecycle states; `starting` and `stopping` reject further transitions. */
export type EngineState = 'down' | 'starting' | 'up' | 'stopping'

/** One service's fate in an `up()` attempt. */
export interface ServiceStartReport {
  name: string
  /** `ready` also covers a service later rolled back by another service's failure. */
  state: 'ready' | 'failed' | 'not-started'
  /** The service's declared readiness probe kind: tcp, http, or command. */
  probe?: ProbeKind
  /** Milliseconds from the service's spawn to its readiness probe passing; absent when the probe never passed. */
  readyAfterMs?: number
  /** Failure explanation naming the phase; present iff `state` is `'failed'`. */
  detail?: string
  /** Bounded tail of the failed service's captured output; present iff `state` is `'failed'`. */
  logTail?: string
}

/** Settled result of one `up()` attempt. */
export interface EnvUpReport {
  ok: boolean
  /** One entry per manifest service, in declaration order. */
  services: readonly ServiceStartReport[]
  /** Milliseconds the whole up attempt took, including any rollback. */
  durationMs?: number
  /** Residue reports of the automatic rollback, present only when that rollback itself failed. */
  teardownFailures?: readonly string[]
}

/** Settled result of one environment teardown; failures never stop later services' teardown. */
export interface EnvDownReport {
  ok: boolean
  /** One line per teardown defect, naming its service. */
  failures: readonly string[]
}

/** One service's re-probed readiness in a `status()` snapshot. */
export interface ServiceStatusReport {
  name: string
  ready: boolean
  /** The service's declared readiness probe kind: tcp, http, or command. */
  probe?: ProbeKind
  /** Milliseconds the re-run readiness probe took to answer on this check. */
  probeMs?: number
}

/** A `status()` snapshot; `services` is populated only while the environment is up. */
export interface EnvStatusReport {
  state: EngineState
  services: readonly ServiceStatusReport[]
}

/**
 * Timing and environment facts of one settled `runTest()`. Every field is
 * optional so earlier report shapes stay valid; each field's own doc says when
 * the engine reports it.
 */
export interface TestRunFacts {
  /** True when the run reused an environment an earlier call had already brought up; false when this run brought it up itself. */
  envReused?: boolean
  /** Milliseconds since the reused environment finished coming up; present only when `envReused` is true. */
  envUpAgeMs?: number
  /** Milliseconds from the start of the run to the settled report, across every phase that ran. */
  durationMs?: number
}

/** {@link TestRunFacts} of a run that got past the up phase. */
export interface TestPhaseFacts extends TestRunFacts {
  /** Per-service startup facts recorded when the backing environment came up. */
  services?: readonly ServiceStartReport[]
  /** Milliseconds the up phase took; present only when this run brought the environment up itself. */
  upDurationMs?: number
  /** Milliseconds the seed command took; present only when a seed command ran. */
  seedDurationMs?: number
  /** Milliseconds the test command took; present only when the test phase ran. */
  testDurationMs?: number
}

/**
 * Live observation of one `runTest()`. The engine feeds it phase-marker lines
 * and the currently running seed/test command's handle; the observer owns the
 * consuming cursor those feed. `signal` carries cancellation the other way:
 * the engine hands it to every spawn and readiness poll of the observed run.
 */
export interface TestRunObserver {
  /** Append one phase-marker line after any stream output that preceded it. */
  mark(line: string): void
  /** Follow one foreground command's merged output until {@link detach}. */
  attach(handle: SubprocessHandle): void
  /** Flush the followed stream's remaining delta and stop following it. */
  detach(): void
  /** Cancellation of the run; aborting terminates the current phase's spawns. */
  readonly signal: AbortSignal
  /** True once the run was cancelled. */
  readonly cancelled: boolean
}

/**
 * One observed, cancellable `runTest()`. `readOutput` consumes what
 * accumulated since the previous call — phase markers plus the live seed/test
 * output, each bounded by the same in-memory tail cap `logs()` reads under.
 */
export interface TestRunHandle {
  /**
   * Settles with the report the synchronous `runTest()` would produce for the
   * same run; a cancelled run settles too, with the cancellation named in the
   * settling phase's detail. Rejects only on a run-owned defect — an invalid
   * manifest, or an engine state that refuses the run.
   */
  done: Promise<IntegrationTestReport>
  /** Consume the phase markers and process output appended since the previous call. */
  readOutput(): string
  /**
   * Cancel the run: terminate the current phase's process tree, and tear an
   * environment this run brought up back down before `done` settles (an
   * environment reused from an earlier `up()` stays up). Synchronous and
   * idempotent.
   */
  cancel(): void
}

/**
 * Settled result of one `runTest()`; `phase` names the stage that settled it.
 * An `'up'` failure carries the whole environment report; a timed-out seed or
 * test run reports a null exit code and says so in `detail`. Timing and
 * environment-reuse facts ride along on every variant.
 */
export type IntegrationTestReport =
  | ({ phase: 'up'; passed: false; up: EnvUpReport } & TestRunFacts)
  | ({ phase: 'seed'; passed: false; exitCode: number | null; outputTail: string; detail?: string } & TestPhaseFacts)
  | ({ phase: 'test'; passed: boolean; exitCode: number | null; outputTail: string; detail?: string } & TestPhaseFacts)
