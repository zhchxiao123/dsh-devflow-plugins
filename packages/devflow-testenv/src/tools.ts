/**
 * The five model-facing tools over one engine instance: `env_up`,
 * `env_status`, `env_logs`, `env_down`, and `integration_test`. Each is a thin
 * projection of an engine call onto its canonical wire value — the engine's
 * failure strings already name the service, the phase, and the exit facts, and
 * they reach the model verbatim because interpreting them is the model's job.
 * Renders lead with the verdict and its duration, then the per-service
 * environment facts, the phase timeline, and — for a test run — the runner's
 * own summary line ahead of the output tail. A missing or invalid manifest
 * surfaces every field-path issue plus the pointer to the `testenv-bootstrap`
 * skill, which owns writing and repairing `testenv.yml`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TestenvEngine } from './engine.ts'
import { ManifestError } from './manifest.ts'
import type { ProbeKind, ServiceStartReport } from './types.ts'

/** The model-facing pointer from a manifest defect to its repair loop. */
const BOOTSTRAP_GUIDANCE
  = 'Run the `testenv-bootstrap` skill to research how this project\'s services start and to write or repair testenv.yml.'

/**
 * Test-runner summary patterns, matched per trimmed line of the test output
 * tail; the last matching line wins. To cover another runner, append a pattern
 * for its one-line summary — extraction stays a per-line match, never an
 * output parser, and a tail no pattern matches renders no summary line at all.
 */
const RUNNER_SUMMARY_PATTERNS: readonly RegExp[] = [
  // pytest: "==== 2 failed, 118 passed in 3.21s ===="
  /^=+ .*\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?).* =+$/,
  // pytest -q: "2 failed, 118 passed in 0.12s"
  /^\d+ (?:passed|failed|errors?|skipped)\b.* in \d+(?:\.\d+)?s\b.*$/,
  // vitest "Tests  1 failed | 117 passed (118)" / jest "Tests: 1 failed, 117 passed, 118 total"
  /^Tests:?\s+.*\d+ (?:passed|failed|skipped|todo|total)\b.*$/,
]

/** The last line of a test output tail a runner-summary pattern matches, or `undefined`. */
function runnerSummary(tail: string): string | undefined {
  return tail.split('\n').map(line => line.trim()).reverse()
    .find(line => RUNNER_SUMMARY_PATTERNS.some(pattern => pattern.test(line)))
}

/** One service entry of the env_up / env_status / integration_test wire value. */
const SERVICE_STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    state: { type: 'string', required: true, enum: ['ready', 'failed', 'not-started'] },
    probe: {
      type: 'string',
      enum: ['tcp', 'http', 'command'],
      description: 'The service\'s declared readiness probe kind.',
    },
    readyAfterMs: {
      type: 'integer',
      description: 'Milliseconds from the service\'s spawn to its readiness probe passing; absent when the probe never passed.',
    },
    probeMs: {
      type: 'integer',
      description: 'Milliseconds the re-run readiness probe took to answer; reported by env_status re-checks.',
    },
    detail: { type: 'string' },
    logTail: { type: 'string' },
  },
} as const

/** The env_up / env_status wire value: an overall verdict plus one entry per service. */
const ENVIRONMENT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    services: { type: 'array', required: true, items: SERVICE_STATE_SCHEMA },
  },
} as const

/** The env_up wire value: the environment verdict plus its duration and the rollback's own residue. */
const ENV_UP_OUTPUT = {
  ...ENVIRONMENT_OUTPUT,
  properties: {
    ...ENVIRONMENT_OUTPUT.properties,
    durationMs: {
      type: 'integer',
      description: 'Milliseconds the whole up attempt took, including any rollback.',
    },
    teardownDetail: {
      type: 'string',
      description: 'Residue of the automatic rollback, one line per defect; present only when that rollback itself failed to tear a started service down cleanly.',
    },
  },
} as const

/** One projected service entry; the render helpers read exactly these fields. */
interface ServiceStateValue {
  name: string
  state: 'ready' | 'failed' | 'not-started'
  probe?: ProbeKind
  readyAfterMs?: number
  probeMs?: number
  detail?: string
  logTail?: string
}

/** Spread one optional wire fact: an absent report field stays absent on the wire. */
function fact<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>
}

/** Wire projection of one engine service report; absent facts stay absent. */
function projectService(report: ServiceStartReport): ServiceStateValue {
  return {
    name: report.name,
    state: report.state,
    ...fact('probe', report.probe),
    ...fact('readyAfterMs', report.readyAfterMs),
    ...report.detail === undefined ? {} : { detail: report.detail },
    ...report.logTail === undefined ? {} : { logTail: report.logTail },
  }
}

/** Human phrasing of a millisecond duration: `850ms`, `12.3s`, `5m02s`. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** Model-facing lines, one block per service: state, name, probe and timing facts, then failure facts. */
function serviceLines(services: readonly ServiceStateValue[]): string[] {
  return services.flatMap((service) => {
    const facts = [
      ...service.probe === undefined ? [] : [`${service.probe} probe`],
      ...service.readyAfterMs === undefined ? [] : [`ready in ${formatMs(service.readyAfterMs)}`],
      ...service.probeMs === undefined ? [] : [`answered in ${formatMs(service.probeMs)}`],
    ]
    return [
      `[${service.state}] ${service.name}${facts.length === 0 ? '' : ` (${facts.join(', ')})`}`,
      ...service.detail === undefined ? [] : [`  ${service.detail}`],
      ...service.logTail === undefined || service.logTail === ''
        ? []
        : ['  log tail:', ...service.logTail.trimEnd().split('\n').map(line => `    ${line}`)],
    ]
  })
}

/** First-line verdict of an env_up report: the outcome, with the attempt's duration when reported. */
function envUpVerdict(value: { ok: boolean; durationMs?: number; teardownDetail?: string }): string {
  const duration = value.durationMs === undefined ? '' : ` in ${formatMs(value.durationMs)}`
  if (value.ok) return `Environment is up${duration}; every service is ready.`
  return value.teardownDetail === undefined
    ? `Environment failed to start${duration}; every started service was torn back down.`
    : `Environment failed to start${duration}, and rolling the started services back left residue.`
}

/** The environment block of an integration_test render: reuse or fresh-up header, then one line per service. */
function environmentLines(value: {
  envReused?: boolean
  envUpAgeMs?: number
  upDurationMs?: number
  services?: readonly ServiceStateValue[]
}): string[] {
  const services = serviceLines(value.services ?? [])
  if (value.envReused === undefined) return services
  const header = value.envReused
    ? `Environment: reused${value.envUpAgeMs === undefined ? '' : ` (up ${formatMs(value.envUpAgeMs)} ago)`}.`
    : `Environment: started by this run${value.upDurationMs === undefined ? '' : ` in ${formatMs(value.upDurationMs)}`}.`
  return [header, ...services]
}

/** The phase timeline of an integration_test render: one ✓/✗ line with its duration per phase that ran. */
function phaseLines(value: {
  phase: string
  passed: boolean
  upDurationMs?: number
  seedDurationMs?: number
  testDurationMs?: number
}): string[] {
  const lines = [
    ...value.upDurationMs === undefined ? [] : [`  ✓ up ${formatMs(value.upDurationMs)}`],
    ...value.seedDurationMs === undefined ? [] : [`  ${value.phase === 'seed' ? '✗' : '✓'} seed ${formatMs(value.seedDurationMs)}`],
    ...value.testDurationMs === undefined ? [] : [`  ${value.passed ? '✓' : '✗'} test ${formatMs(value.testDurationMs)}`],
  ]
  return lines.length === 0 ? [] : ['Phases:', ...lines]
}

/**
 * Run one engine call, rethrowing a manifest defect with the repair pointer
 * appended. The issues keep their field paths verbatim — they are what the
 * bootstrap skill's repair loop edits. Every other failure propagates
 * unchanged.
 * @param work - the engine call.
 * @returns the engine call's settled value.
 */
async function guarded<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ManifestError) throw new Error(`${error.message}\n${BOOTSTRAP_GUIDANCE}`)
    throw error
  }
}

/**
 * Register the five environment tools over one engine instance. Each
 * `ctx.tools.register` files its disposer as an effect of the calling fiber,
 * so disposing the plugin removes the tools with it.
 * @param ctx - registrant context carrying the tool registry.
 * @param engine - the single environment instance every tool drives.
 */
export function registerTools(ctx: Context, engine: TestenvEngine): void {
  ctx.tools.register(defineTool({
    name: 'env_up',
    description:
      'Start this project\'s declared integration-test environment from its testenv.yml manifest: '
      + 'every service starts in declaration order, and each start waits for the previous service\'s '
      + 'readiness probe. Returns one entry per service with its probe kind and readiness duration; '
      + 'a failed service carries its log tail, and any services already started are torn back down. '
      + 'Use it to bring the environment up before working against live services; env_status '
      + 're-checks health later, env_down tears it down, and integration_test brings the environment '
      + 'up by itself. If there is no valid testenv.yml yet, run the testenv-bootstrap skill to '
      + 'research and write one.',
    parameters: {},
    output: {
      schema: ENV_UP_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: [
          envUpVerdict(value),
          ...serviceLines(value.services),
          ...value.teardownDetail === undefined
            ? []
            : ['Rollback residue:', ...value.teardownDetail.trimEnd().split('\n').map(line => `  ${line}`)],
        ].join('\n'),
      }],
    },
    async execute() {
      const report = await guarded(() => engine.up())
      return {
        ok: report.ok,
        services: report.services.map(projectService),
        ...fact('durationMs', report.durationMs),
        ...report.teardownFailures === undefined ? {} : { teardownDetail: report.teardownFailures.join('\n') },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Start the integration-test environment', kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'env_status',
    description:
      'Re-probe every service of the running integration-test environment and report which are '
      + 'healthy right now — each readiness probe is re-run, so this answers current health, not '
      + 'merely whether env_up once succeeded; each entry carries the probe kind and how long the '
      + 're-run probe took to answer. Reports no services while the environment is not up. Use it '
      + 'before pointing tests at a long-lived environment, or to find which service decayed; read '
      + 'a decayed service\'s output with env_logs.',
    parameters: {},
    output: {
      schema: ENVIRONMENT_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: value.services.length === 0
          ? 'The environment is not up; env_up starts it.'
          : [
            value.ok
              ? 'Environment is up; every readiness probe passed just now.'
              : 'Environment is up, but not every readiness probe passed just now.',
            ...serviceLines(value.services),
          ].join('\n'),
      }],
    },
    async execute() {
      const status = await guarded(() => engine.status())
      if (status.state !== 'up') return { ok: false, services: [] }
      return {
        ok: status.services.every(service => service.ready),
        services: status.services.map(service => ({
          name: service.name,
          state: service.ready ? 'ready' as const : 'failed' as const,
          ...fact('probe', service.probe),
          ...fact('probeMs', service.probeMs),
          ...service.ready ? {} : { detail: 'its readiness probe did not pass when re-checked' },
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check integration-test environment health', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'env_logs',
    description:
      'Read the captured output of one environment service (stdout with stderr merged in, as a '
      + 'bounded in-memory tail). Pass a previous call\'s nextOffset as fromOffset to read only what '
      + 'is new; omit it to read from the start. lossy: true means the tail overflowed and earlier '
      + 'bytes were dropped. Logs stay readable after a service\'s process exits, until env_down.',
    parameters: {
      service: { type: 'string', required: true, description: 'Service name as declared in testenv.yml.' },
      fromOffset: {
        type: 'integer',
        description: 'Byte offset from a previous call\'s nextOffset; omitted reads from the start.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          nextOffset: { type: 'integer', required: true },
          lossy: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          ...value.lossy ? ['(the in-memory tail overflowed; earlier output was dropped)'] : [],
          value.text === '' ? '(no new output)' : value.text,
          `(next offset: ${value.nextOffset})`,
        ].join('\n'),
      }],
    },
    async execute(args) {
      if (args.fromOffset !== undefined && args.fromOffset < 0) {
        throw new Error(`fromOffset must be a non-negative byte offset, got ${args.fromOffset}`)
      }
      const read = await guarded(() => engine.logs(args.service, args.fromOffset))
      return { text: read.text, nextOffset: read.nextOffset, lossy: read.lossy }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Read ${args.service} service logs`,
      kind: 'read',
      rawInput: { service: args.service, ...args.fromOffset === undefined ? {} : { fromOffset: args.fromOffset } },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'env_down',
    description:
      'Tear the integration-test environment down in reverse start order: a service with a declared '
      + 'down command runs it, then every service\'s process tree is terminated. Teardown never stops '
      + 'at one service\'s failure; residue is aggregated into detail. Safe to call when the '
      + 'environment is already down; the same teardown also runs automatically when the session ends.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? 'Environment is down; no service left residue.'
          : `Environment is down, with teardown residue:\n${value.detail ?? '(unreported)'}`,
      }],
    },
    async execute() {
      const report = await guarded(() => engine.down())
      return { ok: report.ok, ...report.failures.length === 0 ? {} : { detail: report.failures.join('\n') } }
    },
    presentCall: () => ({ card: 'generic', title: 'Tear the integration-test environment down', kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'integration_test',
    description:
      'Run this project\'s declared integration test: bring the environment up when it is not '
      + '(exactly like env_up), run the declared seed command when there is one, then run the test '
      + 'command. The report names the phase that settled it — up, seed, or test — with the exit '
      + 'code, per-phase durations, and a bounded output tail; envReused says whether the run reused '
      + 'an environment an earlier call had already brought up or brought it up itself; a failed up '
      + 'phase reports per-service startup state instead. The environment stays up afterwards for '
      + 're-runs; env_down tears it down. If there is no valid testenv.yml yet, run the '
      + 'testenv-bootstrap skill first.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean', required: true },
          phase: { type: 'string', required: true, enum: ['up', 'seed', 'test'] },
          exitCode: {
            type: 'integer',
            description: 'Absent when the phase produced no exit code (a failed up phase, or a run cut by its deadline).',
          },
          outputTail: { type: 'string' },
          detail: { type: 'string' },
          services: {
            type: 'array',
            items: SERVICE_STATE_SCHEMA,
            description: 'Per-service startup facts: the failed up phase\'s full report, or the facts recorded when the environment came up.',
          },
          envReused: {
            type: 'boolean',
            description: 'True when the run reused an environment an earlier call had already brought up; false when this run brought it up itself.',
          },
          envUpAgeMs: {
            type: 'integer',
            description: 'Milliseconds since the reused environment finished coming up; present only when envReused is true.',
          },
          upDurationMs: {
            type: 'integer',
            description: 'Milliseconds the up phase took; present only when this run brought the environment up itself.',
          },
          seedDurationMs: {
            type: 'integer',
            description: 'Milliseconds the seed command took; present only when a seed command ran.',
          },
          testDurationMs: {
            type: 'integer',
            description: 'Milliseconds the test command took; present only when the test phase ran.',
          },
          durationMs: {
            type: 'integer',
            description: 'Milliseconds from the start of the run to the settled report, across every phase that ran.',
          },
        },
      },
      render: (_args, value) => {
        if (value.phase === 'up') {
          return [{
            type: 'text',
            text: [
              `Integration test failed${value.durationMs === undefined ? '' : ` in ${formatMs(value.durationMs)}`}: the environment did not start.`,
              ...serviceLines(value.services ?? []),
            ].join('\n'),
          }]
        }
        const exit = value.exitCode === undefined ? '' : ` (exit code ${value.exitCode})`
        const duration = value.durationMs === undefined ? '' : ` in ${formatMs(value.durationMs)}`
        const tail = value.outputTail ?? ''
        const summary = value.phase === 'test' ? runnerSummary(tail) : undefined
        return [{
          type: 'text',
          text: [
            value.passed
              ? `Integration test passed${exit}${duration}.`
              : `Integration test failed during the ${value.phase} phase${exit}${duration}.`,
            ...value.detail === undefined ? [] : [value.detail],
            ...environmentLines(value),
            ...phaseLines(value),
            ...summary === undefined ? [] : [`Runner summary: ${summary}`],
            ...tail === '' ? [] : ['--- output tail ---', tail.trimEnd()],
          ].join('\n'),
        }]
      },
    },
    async execute() {
      const report = await guarded(() => engine.runTest())
      if (report.phase === 'up') {
        return {
          passed: false,
          phase: 'up' as const,
          services: report.up.services.map(projectService),
          ...fact('envReused', report.envReused),
          ...fact('durationMs', report.durationMs),
        }
      }
      return {
        passed: report.passed,
        phase: report.phase,
        ...report.exitCode === null ? {} : { exitCode: report.exitCode },
        outputTail: report.outputTail,
        ...report.detail === undefined ? {} : { detail: report.detail },
        ...fact('services', report.services?.map(projectService)),
        ...fact('envReused', report.envReused),
        ...fact('envUpAgeMs', report.envUpAgeMs),
        ...fact('upDurationMs', report.upDurationMs),
        ...fact('seedDurationMs', report.seedDurationMs),
        ...fact('testDurationMs', report.testDurationMs),
        ...fact('durationMs', report.durationMs),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Run the integration test', kind: 'execute' }),
  }))
}
