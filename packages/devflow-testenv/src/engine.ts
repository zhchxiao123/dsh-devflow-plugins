/**
 * The environment state machine: one engine instance drives the manifest's
 * services through `down → starting → up → stopping → down` over the
 * subprocess seam. The engine owns every deadline — readiness polling, down
 * commands, seed/test runs — because the seam deliberately carries none, and
 * a running environment is one registered effect whose disposer is the whole
 * teardown, so a disposed fiber structurally cannot leak service processes.
 *
 * Startup applies one rule to self-exiting and long-lived `up` commands
 * alike: a passing probe means ready regardless of process liveness, a
 * process that fails (non-zero exit, signal, or spawn error) before its probe
 * passes fails the service immediately, and a clean exit keeps the probe
 * polling until the readiness deadline. Any service failure rolls the
 * already-started services back in reverse order.
 */

import { resolve } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import { collectEvidence } from './evidence.ts'
import { loadManifest } from './manifest.ts'
import { commandProbe, httpProbe, pollUntilReady, tcpProbe } from './probes.ts'
import type {
  EngineHost,
  EngineSettings,
  EngineState,
  EnvDownReport,
  EnvStatusReport,
  EnvUpReport,
  PollOutcome,
  ReadinessProbe,
  ServiceSpec,
  ServiceStartReport,
  ServiceStatusReport,
  SpawnPlan,
  SpawnRunner,
  TestenvManifest,
  TestPhaseFacts,
  TestRunReport,
  TestRunHandle,
  TestRunObserver,
} from './types.ts'

/**
 * Whole-stream spill cap per captured service stream. Fixed rather than
 * configured: the spill file only backs recovery of a lossy incremental read,
 * the model-facing surface stays the bounded in-memory tail, and a service
 * log past this cap is bulk diagnostics no manifest-repair loop pages
 * through.
 */
const LOG_SPILL_MAX_BYTES = 16 * 1024 * 1024

/** One spawned `up` process and the exit facts observed so far. */
interface StartedService {
  spec: ServiceSpec
  handle: SubprocessHandle
  /** Exit facts once the process closed; `undefined` while it runs. */
  exit?: SubprocessOutcome
  /** Milliseconds from spawn to the readiness probe passing; set iff it passed. */
  readyAfterMs?: number
}

/** Startup facts recorded when the environment last came up, for status and reuse reporting. */
interface UpRecord {
  /** Monotonic `performance.now()` mark of the moment the environment came up. */
  at: number
  /** Milliseconds the up attempt took. */
  durationMs: number
  /** Per-service startup facts, in declaration order. */
  services: readonly ServiceStartReport[]
}

/** What one failed service start reports into the environment-level result. */
interface StartFailure {
  detail: string
  logTail: string
}

/** Settled facts of one bounded foreground command. */
interface BoundedRun {
  outcome: SubprocessOutcome
  /** True when the deadline aborted the run and its tree was terminated. */
  timedOut: boolean
  tail: string
  /** Milliseconds from spawn to the settled outcome. */
  durationMs: number
}

/**
 * Wrap one manifest command for the shell. `exec 2>&1` merges stderr into the
 * collected stdout stream, so one caller-held offset covers the whole service
 * log; the separate stderr collect only ever sees shell-level failures that
 * precede the merge.
 */
function shellArgv(command: string): readonly string[] {
  return ['sh', '-c', `exec 2>&1\n${command}`]
}

/** Human phrasing of exit facts for failure details. */
function exitFacts(outcome: SubprocessOutcome): string {
  if (outcome.exitCode !== null) return `exit code ${outcome.exitCode}`
  /* v8 ignore next -- Node's close event reports a signal whenever the exit code is null. */
  return `killed by ${outcome.signal ?? 'a signal'}`
}

/** The bounded tail of everything a handle captured, both streams. */
function tailOf(handle: SubprocessHandle): string {
  const out = handle.collected.stdout?.readFrom(0).text ?? ''
  const err = handle.collected.stderr?.readFrom(0).text ?? ''
  return err === '' ? out : `${out}--- stderr ---\n${err}`
}

function message(error: unknown): string {
  /* v8 ignore next -- every in-repo throw is an Error; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}

/** Whole milliseconds elapsed since a `performance.now()` mark — monotonic, never wall-clock. */
function since(start: number): number {
  return Math.round(performance.now() - start)
}

/**
 * The streaming half of one `runTestObserved()`: phase markers and the live
 * seed/test output funnel into one consuming buffer, and one AbortController
 * carries cancellation into the run's spawns and readiness polls. The buffer
 * stays bounded the way `logs()` reads are: stream output arrives as offset
 * deltas of the spawn's bounded in-memory tail, and a lossy read is announced
 * instead of silently dropped.
 */
class ObservedRun implements TestRunObserver {
  private readonly aborter = new AbortController()
  private buffer = ''
  private stream: (() => SubprocessOutputRead) | undefined
  /** True when the observed run reused an environment an earlier call brought up. */
  reusedEnvironment = false

  get signal(): AbortSignal {
    return this.aborter.signal
  }

  get cancelled(): boolean {
    return this.aborter.signal.aborted
  }

  /** Request cancellation; the abort is what every observed spawn and poll reacts to. Idempotent. */
  cancel(): void {
    this.aborter.abort()
  }

  mark(line: string): void {
    this.flush()
    if (this.buffer !== '' && !this.buffer.endsWith('\n')) this.buffer += '\n'
    this.buffer += `${line}\n`
  }

  attach(handle: SubprocessHandle): void {
    const source = handle.collected.stdout
    /* v8 ignore next -- every foreground spawn collects stdout. */
    if (source === undefined) return
    let offset = 0
    this.stream = () => {
      const read = source.readFrom(offset)
      offset = read.nextOffset
      return read
    }
  }

  detach(): void {
    this.flush()
    this.stream = undefined
  }

  /** Consume everything appended since the previous call. */
  readOutput(): string {
    this.flush()
    const text = this.buffer
    this.buffer = ''
    return text
  }

  /** Append the followed stream's unread delta, announcing a lossy read. */
  private flush(): void {
    if (this.stream === undefined) return
    const read = this.stream()
    if (read.lossy) this.buffer += '(the in-memory tail overflowed; earlier output was dropped)\n'
    this.buffer += read.text
  }
}

/**
 * One test environment, serving the one workspace root its
 * settings carry (the plugin builds one engine per workspace). A single
 * instance holds at most one running environment; `up()` while not down and
 * `down()` while transitioning fail loud instead of queueing.
 */
export class TestenvEngine {
  private readonly host: EngineHost
  private readonly settings: EngineSettings
  private lifecycle: EngineState = 'down'
  private manifest: TestenvManifest | undefined
  private started: StartedService[] = []
  private disposeEnvironment: (() => Promise<void>) | undefined
  private lastTeardown: EnvDownReport | undefined
  private upRecord: UpRecord | undefined
  /** Backs the command probe: run one spawn to completion and report exit facts. */
  private readonly runner: SpawnRunner = spec => this.host.subprocess.spawn(spec).done

  constructor(host: EngineHost, settings: EngineSettings) {
    this.host = host
    this.settings = settings
  }

  /** Current lifecycle state. */
  get state(): EngineState {
    return this.lifecycle
  }

  /**
   * Load the manifest and start every service in declaration order, gating
   * each start on the previous service's readiness. Success registers the
   * environment as an effect on the host fiber; any failure rolls already
   * started services back in reverse order before reporting.
   * @param observer - live observation of an observed run: per-service phase
   *   markers, and a cancellation signal every readiness poll honors.
   * @returns the per-service report; `ok` is false when any service failed.
   * @throws {ManifestError} when the manifest is missing or invalid.
   * @throws {Error} when the environment is not down.
   */
  async up(observer?: TestRunObserver): Promise<EnvUpReport> {
    if (this.lifecycle !== 'down') {
      throw new Error(`the environment is ${this.lifecycle}; bring it down before starting it again`)
    }
    this.lifecycle = 'starting'
    const startedAt = performance.now()
    let manifest: TestenvManifest
    try {
      manifest = await loadManifest(resolve(this.settings.root, this.settings.manifestPath))
    } catch (error) {
      this.lifecycle = 'down'
      throw error
    }
    this.manifest = manifest
    for (const [index, service] of manifest.services.entries()) {
      observer?.mark(`[up] starting service ${JSON.stringify(service.name)} (${index + 1}/${manifest.services.length})`)
      const failure = await this.startService(service, observer)
      if (failure !== undefined) {
        observer?.mark(`[up] ${failure.detail}`)
        return this.rollBack(manifest, index, failure, startedAt)
      }
      observer?.mark(`[up] service ${JSON.stringify(service.name)} is ready`)
    }
    this.lifecycle = 'up'
    const services = this.started.map(record => this.readyReport(record))
    const durationMs = since(startedAt)
    this.upRecord = { at: performance.now(), durationMs, services }
    this.disposeEnvironment = this.host.effect(() => () => this.teardownEnvironment(), 'testenv environment')
    return { ok: true, services, durationMs }
  }

  /**
   * Tear the running environment down through the same disposer the effect
   * registered, in reverse start order. Idempotent when already down.
   * @returns the aggregated teardown report; `ok` is false when any service left residue.
   * @throws {Error} while the environment is starting or stopping.
   */
  async down(): Promise<EnvDownReport> {
    if (this.lifecycle === 'down') return { ok: true, failures: [] }
    if (this.lifecycle !== 'up') {
      throw new Error(`the environment is ${this.lifecycle}; wait for that transition to settle before calling down`)
    }
    const dispose = this.disposeEnvironment
    /* v8 ignore next -- the 'up' state is only entered together with the registered environment effect. */
    if (dispose === undefined) throw new Error('the environment effect is missing')
    await dispose()
    /* v8 ignore next -- teardownEnvironment records the report before the disposer settles. */
    return this.lastTeardown ?? { ok: true, failures: [] }
  }

  /**
   * Re-probe every service's readiness — the environment being up only means
   * it once was; this answers whether each service is healthy now.
   * @returns the lifecycle state, with one fresh probe answer per service while up.
   */
  async status(): Promise<EnvStatusReport> {
    if (this.lifecycle !== 'up') return { state: this.lifecycle, services: [] }
    const services: ServiceStatusReport[] = []
    for (const service of this.activeManifest().services) {
      const checkedAt = performance.now()
      const ready = await this.probeOnce(service)
      services.push({ name: service.name, ready, probe: service.ready.probe, probeMs: since(checkedAt) })
    }
    return { state: 'up', services }
  }

  /**
   * Read a service's captured log incrementally. The caller holds the offset;
   * a service whose process already exited stays readable until teardown.
   * @param service - manifest service name.
   * @param fromOffset - whole-stream byte offset from a prior read; 0 reads from the start.
   * @returns the delta text, the next offset, and the `lossy` fact.
   * @throws {Error} for an unknown service or an environment that is not up.
   */
  logs(service: string, fromOffset = 0): SubprocessOutputRead {
    const record = this.started.find(entry => entry.spec.name === service)
    if (record === undefined) {
      throw new Error(this.lifecycle === 'up'
        ? `unknown service ${JSON.stringify(service)}; the manifest declares: ${this.started.map(entry => entry.spec.name).join(', ')}`
        : `the environment is ${this.lifecycle}; logs are only readable while it is up`)
    }
    const reader = record.handle.collected.stdout
    /* v8 ignore next -- every up process is spawned with stdout in collect mode. */
    if (reader === undefined) throw new Error(`service ${JSON.stringify(service)} captured no output`)
    return reader.readFrom(fromOffset)
  }

  /**
   * Run the declared test: bring the environment up when it is not, run
   * the seed command when one is declared, then run the test command — each
   * stage stopping the run on failure. The report carries the run's timing
   * facts, and says whether the environment was brought up by this run or
   * reused from an earlier call.
   * @returns the settled report; `phase` names the stage that settled it.
   */
  async runTest(): Promise<TestRunReport> {
    return this.executeRun(undefined)
  }

  /**
   * Run the declared test as an observed, cancellable run: the same
   * phases, failure semantics, and report as {@link runTest}, plus a
   * consuming output cursor of phase markers and live seed/test output.
   * Cancelling terminates the current phase's process tree through the same
   * signals the deadlines use; an environment the run brought up itself is
   * torn back down through the ordinary teardown before `done` settles, while
   * an environment reused from an earlier `up()` stays up because that call
   * owns it.
   * @returns the live handle carrying `done`, `readOutput`, and `cancel`.
   */
  runTestObserved(): TestRunHandle {
    const run = new ObservedRun()
    const done = (async () => {
      try {
        return await this.executeRun(run)
      } finally {
        if (run.cancelled && !run.reusedEnvironment && this.lifecycle === 'up') {
          run.mark('[cancelled] tearing the environment down')
          await this.down()
        }
      }
    })()
    return {
      done,
      readOutput: () => run.readOutput(),
      cancel: () => {
        run.cancel()
      },
    }
  }

  /** One test run; `run` being undefined is the synchronous, unobserved path. */
  private async executeRun(run: ObservedRun | undefined): Promise<TestRunReport> {
    const startedAt = performance.now()
    const reused = this.lifecycle === 'up'
    if (run !== undefined) run.reusedEnvironment = reused
    if (reused) {
      run?.mark('[up] reusing the environment an earlier call brought up')
    } else {
      const up = await this.up(run)
      if (!up.ok) {
        run?.mark('[up] the environment failed to start; every started service was rolled back')
        return { phase: 'up', passed: false, up, envReused: false, durationMs: since(startedAt) }
      }
      run?.mark('[up] every service is ready')
    }
    const environment = this.environmentFacts(reused)
    const manifest = this.activeManifest()
    let seedDurationMs: number | undefined
    if (manifest.seed !== undefined) {
      run?.mark(`[seed] running: ${manifest.seed}`)
      const seed = await this.runForeground(manifest.seed, run)
      seedDurationMs = seed.durationMs
      if (seed.outcome.exitCode !== 0) {
        run?.mark(`[seed] failed (${exitFacts(seed.outcome)})`)
        return { phase: 'seed', passed: false, ...this.foregroundFacts(seed, 'seed', run), ...environment, seedDurationMs, durationMs: since(startedAt) }
      }
      run?.mark('[seed] done (exit code 0)')
    }
    run?.mark(`[test] running: ${manifest.test}`)
    const test = await this.runForeground(manifest.test, run)
    run?.mark(`[test] settled (${exitFacts(test.outcome)})`)
    const passed = test.outcome.exitCode === 0
    // Only a red run pays for collection: a green one has nothing to explain,
    // and no current consumer asks for a passing run's trace.
    const evidence = passed ? undefined : await collectEvidence(manifest, this.settings.root)
    if (evidence !== undefined) run?.mark(`[test] collected ${evidence.files.length} evidence file(s)`)
    return {
      phase: 'test',
      passed,
      ...this.foregroundFacts(test, 'test', run),
      ...environment,
      ...seedDurationMs === undefined ? {} : { seedDurationMs },
      testDurationMs: test.durationMs,
      durationMs: since(startedAt),
      ...evidence === undefined ? {} : { evidence },
    }
  }

  /** Start one service and wait for its readiness gate. */
  private async startService(service: ServiceSpec, observer?: TestRunObserver): Promise<StartFailure | undefined> {
    const spawnedAt = performance.now()
    const handle = this.host.subprocess.spawn(this.spawnSpec(service.up, service, true))
    const record: StartedService = { spec: service, handle }
    this.started.push(record)
    const failed = new AbortController()
    let spawnFailure: string | undefined
    void handle.done.then((outcome) => {
      record.exit = outcome
      if (outcome.exitCode !== 0) failed.abort()
    }, (error: unknown) => {
      spawnFailure = message(error)
      failed.abort()
    })
    const timeoutMs = service.readyTimeoutMs ?? this.settings.defaultReadyTimeoutMs
    const cancel = observer?.signal
    let outcome: PollOutcome
    try {
      outcome = await pollUntilReady(this.probeFor(service), {
        intervalMs: this.settings.readyPollIntervalMs,
        timeoutMs,
        signal: cancel === undefined ? failed.signal : AbortSignal.any([failed.signal, cancel]),
      })
    } catch (error) {
      return this.startFailure(record, `its readiness probe failed: ${message(error)}`)
    }
    if (outcome.ready) {
      record.readyAfterMs = since(spawnedAt)
      return undefined
    }
    if (outcome.cause === 'aborted') {
      // The cancel check comes first: a cancelled poll aborts without exit facts.
      if (cancel?.aborted === true) {
        return this.startFailure(record, 'the run was cancelled before the service became ready')
      }
      return this.startFailure(record, spawnFailure !== undefined
        ? `its up command could not be spawned: ${spawnFailure}`
        : `its process exited (${exitFacts(this.exitOf(record))}) before it became ready`)
    }
    return this.startFailure(record, record.exit !== undefined
      ? `its process exited (${exitFacts(record.exit)}) and the service never became ready within ${timeoutMs}ms`
      : `the service did not become ready within ${timeoutMs}ms; its process is still running and will be torn down`)
  }

  /** Compose one service's failure detail with its phase and log tail. */
  private startFailure(record: StartedService, cause: string): StartFailure {
    return { detail: `service ${JSON.stringify(record.spec.name)} failed during startup: ${cause}`, logTail: tailOf(record.handle) }
  }

  /** The recorded exit facts of an aborted start. */
  private exitOf(record: StartedService): SubprocessOutcome {
    /* v8 ignore next 2 -- the readiness abort only fires from the done callbacks, which record the exit first. */
    if (record.exit === undefined) throw new Error(`service ${JSON.stringify(record.spec.name)} has no exit facts`)
    return record.exit
  }

  /** Roll every started service back in reverse order and assemble the failed report. */
  private async rollBack(manifest: TestenvManifest, failedIndex: number, failure: StartFailure, startedAt: number): Promise<EnvUpReport> {
    this.lifecycle = 'stopping'
    const records = [...this.started]
    const rollback = await this.teardownStarted()
    this.lifecycle = 'down'
    this.manifest = undefined
    const services = records.map((record, index): ServiceStartReport => index < failedIndex
      ? this.readyReport(record)
      : { name: record.spec.name, state: 'failed', probe: record.spec.ready.probe, detail: failure.detail, logTail: failure.logTail })
    for (const service of manifest.services.slice(records.length)) {
      services.push({ name: service.name, state: 'not-started', probe: service.ready.probe })
    }
    return { ok: false, services, durationMs: since(startedAt), ...rollback.ok ? {} : { teardownFailures: rollback.failures } }
  }

  /** The startup facts of one service whose readiness probe passed. */
  private readyReport(record: StartedService): ServiceStartReport {
    /* v8 ignore next -- a ready record always carries the readiness duration its probe pass recorded. */
    if (record.readyAfterMs === undefined) throw new Error(`service ${JSON.stringify(record.spec.name)} has no readiness duration`)
    return { name: record.spec.name, state: 'ready', probe: record.spec.ready.probe, readyAfterMs: record.readyAfterMs }
  }

  /** How the environment behind a `runTest()` came to be up, with its per-service startup facts. */
  private environmentFacts(reused: boolean): Pick<TestPhaseFacts, 'envReused' | 'envUpAgeMs' | 'upDurationMs' | 'services'> {
    const record = this.upRecord
    /* v8 ignore next -- the 'up' state is only entered together with the recorded startup facts. */
    if (record === undefined) throw new Error('the environment has no recorded startup facts')
    return {
      envReused: reused,
      services: record.services,
      ...reused ? { envUpAgeMs: since(record.at) } : { upDurationMs: record.durationMs },
    }
  }

  /** The effect disposer: tear every started service down and settle the state. */
  private async teardownEnvironment(): Promise<void> {
    this.lifecycle = 'stopping'
    this.lastTeardown = await this.teardownStarted()
    this.lifecycle = 'down'
    this.manifest = undefined
    this.upRecord = undefined
    this.disposeEnvironment = undefined
  }

  /** Tear every started service down in reverse start order, aggregating failures. */
  private async teardownStarted(): Promise<EnvDownReport> {
    const failures: string[] = []
    for (const record of this.started.splice(0).reverse()) {
      failures.push(...await this.teardownService(record))
    }
    return { ok: failures.length === 0, failures }
  }

  /**
   * Tear one service down: run its declared down command when present, then
   * unconditionally terminate the up process tree — idempotent and a no-op
   * once the tree is gone — and wait boundedly for whole-tree exit.
   */
  private async teardownService(record: StartedService): Promise<string[]> {
    const notes: string[] = []
    if (record.spec.down !== undefined) notes.push(...await this.runDown(record.spec, record.spec.down))
    record.handle.terminate()
    const exited = await record.handle.waitForExit(AbortSignal.timeout(this.settings.downTimeoutMs))
    if (!exited) {
      notes.push(`service ${JSON.stringify(record.spec.name)}: the up process tree did not exit within ${this.settings.downTimeoutMs}ms of termination`)
    }
    return notes
  }

  /** Run one declared down command; every defect degrades to tree termination. */
  private async runDown(spec: ServiceSpec, command: string): Promise<string[]> {
    const name = JSON.stringify(spec.name)
    let run: BoundedRun
    try {
      run = await this.runBounded(command, spec, this.settings.downTimeoutMs)
    } catch (error) {
      return [`service ${name}: the down command could not be spawned (${message(error)}); the process tree was terminated instead`]
    }
    if (run.timedOut) {
      return [`service ${name}: the down command timed out after ${this.settings.downTimeoutMs}ms; the process tree was terminated instead`]
    }
    if (run.outcome.exitCode !== 0) {
      return [`service ${name}: the down command failed (${exitFacts(run.outcome)})${run.tail === '' ? '' : `: ${run.tail}`}`]
    }
    return []
  }

  /** Run one shell command to completion under a deadline the engine holds. */
  private async runBounded(
    command: string,
    service: ServiceSpec | undefined,
    timeoutMs: number,
    run?: TestRunObserver,
  ): Promise<BoundedRun> {
    const spawnedAt = performance.now()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = run === undefined ? timeout : AbortSignal.any([timeout, run.signal])
    const handle = this.host.subprocess.spawn({ ...this.spawnSpec(command, service, false), signal })
    run?.attach(handle)
    try {
      const outcome = await handle.done
      return { outcome, timedOut: timeout.aborted, tail: tailOf(handle), durationMs: since(spawnedAt) }
    } catch (error) {
      // Cancellation may win before the platform runner has consumed its
      // launch request. Once our signal is aborted that rejection is the
      // requested outcome, not an infrastructure failure to leak to callers.
      if (!signal.aborted) throw error
      return {
        outcome: { exitCode: null, signal: null },
        timedOut: timeout.aborted,
        tail: tailOf(handle),
        durationMs: since(spawnedAt),
      }
    } finally {
      run?.detach()
    }
  }

  /** Run one seed/test command in the workspace root under the test deadline. */
  private runForeground(command: string, run?: TestRunObserver): Promise<BoundedRun> {
    return this.runBounded(command, undefined, this.settings.testTimeoutMs, run)
  }

  /** The exit facts a seed/test report carries, annotated when a cancel or the deadline cut the run. */
  private foregroundFacts(
    run: BoundedRun,
    stage: string,
    observed?: TestRunObserver,
  ): { exitCode: number | null; outputTail: string; detail?: string } {
    return {
      exitCode: observed?.cancelled === true || run.timedOut ? null : run.outcome.exitCode,
      outputTail: run.tail,
      ...observed?.cancelled === true
        ? { detail: `the ${stage} command was cancelled and its process tree was terminated` }
        : run.timedOut ? { detail: `the ${stage} command timed out after ${this.settings.testTimeoutMs}ms and was terminated` } : {},
    }
  }

  /** One fully-specified spawn: shell wrapping, resolved cwd, layered env, collected output. */
  private spawnSpec(command: string, service: ServiceSpec | undefined, spill: boolean): SpawnPlan {
    const maxBytes = this.settings.logTailBytes
    return {
      argv: shellArgv(command),
      cwd: resolve(this.settings.root, service?.cwd ?? '.'),
      stdio: {
        stdin: 'ignore',
        stdout: spill ? { maxBytes, spill: { maxBytes: LOG_SPILL_MAX_BYTES } } : { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: this.settings.graceMs,
      env: { ...scrubbedParentEnv(), ...service?.env },
    }
  }

  /** The readiness probe one service's declaration selects. */
  private probeFor(service: ServiceSpec): ReadinessProbe {
    const ready = service.ready
    switch (ready.probe) {
      case 'tcp': return tcpProbe(ready.tcp)
      case 'http': return httpProbe(ready.http)
      case 'command': return commandProbe(this.runner, this.spawnSpec(ready.command.run, service, false))
    }
  }

  /** One status re-probe, bounded by the service's own readiness deadline. */
  private probeOnce(service: ServiceSpec): Promise<boolean> {
    const timeoutMs = service.readyTimeoutMs ?? this.settings.defaultReadyTimeoutMs
    return this.probeFor(service)(AbortSignal.timeout(timeoutMs))
  }

  /** The manifest of the active environment. */
  private activeManifest(): TestenvManifest {
    const manifest = this.manifest
    /* v8 ignore next -- every non-down state is entered with the manifest set. */
    if (manifest === undefined) throw new Error('no manifest is loaded')
    return manifest
  }
}
