/**
 * The five model-facing tools over a real tool registry and real child
 * processes: registration and fiber-disposal removal, per-call workspace-root
 * resolution from the calling session's cwd (including the fail-loud path for
 * a call without one, and two workspaces served side by side), each tool's
 * success and failure renders, the manifest-defect pointer at the bootstrap
 * skill, the presentCall annotations, and the render branches only a crafted
 * value can reach (render is pure, so those are driven directly).
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { TestenvEngine } from '../src/engine.ts'
import { registerTools } from '../src/tools.ts'
import type { EngineSettings } from '../src/types.ts'

// Module-local declaration of the one `process` member this suite touches:
// the type-aware linter resolves the @types/node `process` global
// nondeterministically in this workspace, and a local declaration keeps its
// verdict stable. Runtime still binds the real global.
declare const process: { kill(pid: number, signal: number): true }

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function settings(root: string, overrides: Partial<EngineSettings> = {}): EngineSettings {
  return {
    root,
    manifestPath: 'testenv.yml',
    readyPollIntervalMs: 25,
    defaultReadyTimeoutMs: 5000,
    downTimeoutMs: 5000,
    testTimeoutMs: 10000,
    logTailBytes: 65536,
    graceMs: 300,
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

/**
 * Liveness that counts a zombie as dead: torn-down grandchildren reparent to
 * a container init that reaps lazily, and `kill(pid, 0)` answers success for
 * a zombie.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    // Swallows ESRCH — no such process is the clean "gone" answer; EPERM
    // cannot happen for processes this suite spawned itself.
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')')).split(/\s+/)[1] !== 'Z'
  } catch {
    // Swallows a missing /proc entry (non-Linux host, or reaped between the
    // two probes); the signal probe above already answered alive.
    return true
  }
}

/** Blank every rendered duration, so two runs of the same scenario compare byte-equal. */
function stripDurations(text: string): string {
  return text.replace(/\d+(?:\.\d+)?m?s\b/g, '_')
}

/** A port nothing listens on: bind, read, release. */
async function closedPort(): Promise<number> {
  const server = createTcpServer()
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) })
  })
  await new Promise((resolve) => { server.close(resolve) })
  return port
}

interface ToolsEnv {
  ctx: Context
  root: string
  fiber: { dispose(): Promise<void> }
  /** The default caller: a registered agent whose session cwd is the workspace root. */
  agent: Agent
  /** Execute one registered tool as the default caller, or as an explicit one. */
  call: (name: string, args?: object, caller?: Agent) => Promise<{ isError: boolean | undefined; text: string }>
}

interface BootOptions {
  /** Load the real `LocalJobRegistry` as `ctx.jobs`. */
  jobs?: boolean
  /** Attach a job controller (the role `dsh-tool-jobs` plays); default true when `jobs` is set. */
  controller?: boolean
}

/**
 * The registered-agent fixture from the devflow-tool composition suite,
 * carrying the session cwd the tools resolve the workspace root from; a
 * fixture without one exercises the fail-loud path.
 */
function agentFor(ctx: Context, name: string, cwd?: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, undefined, cwd === undefined
    ? undefined
    : { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

async function bootTools(
  manifest: string | undefined,
  overrides: Partial<EngineSettings> = {},
  options: BootOptions = {},
): Promise<ToolsEnv> {
  const root = await mkdtemp(join(tmpdir(), 'testenv-tools-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  if (manifest !== undefined) await writeFile(join(root, 'testenv.yml'), manifest)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.jobs === true) {
    await ctx.plugin(LocalJobRegistry, {})
    if (options.controller !== false) ctx.jobs.attachController('spec-controller')
  }
  const fiber = await ctx.plugin({
    inject: ['tools', 'subprocess'],
    apply: (child: Context) => {
      // The same per-root lazy map the plugin's apply() builds.
      const engines = new Map<string, TestenvEngine>()
      registerTools(child, (engineRoot) => {
        let engine = engines.get(engineRoot)
        if (engine === undefined) {
          engine = new TestenvEngine(child, settings(engineRoot, overrides))
          engines.set(engineRoot, engine)
        }
        return engine
      })
    },
  })
  const agent = agentFor(ctx, `testenv-caller-${basename(root)}`, root)
  return {
    ctx,
    root,
    fiber,
    agent,
    call: (name, args = {}, caller = agent) => callTool(ctx, name, args, caller),
  }
}

async function callTool(
  ctx: Context,
  name: string,
  args: object = {},
  agent?: Agent,
): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `testenv-${name}-${Math.random()}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  const content = result.content as { type: string; text?: string }[]
  return { isError: result.isError, text: content.filter(block => block.type === 'text').map(block => block.text).join('') }
}

/** Drive one registered tool's pure render directly with a crafted value. */
function renderText(ctx: Context, name: string, value: unknown): string {
  const definition = ctx.tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const content = definition.output.render({}, value as never) as { text?: string }[]
  return content.map(block => block.text ?? '').join('')
}

const TOOL_NAMES = ['env_up', 'env_status', 'env_logs', 'env_down', 'integration_test'] as const

/** Regex source matching one rendered duration: `123ms`, `1.2s`. */
const D = String.raw`\d+(?:\.\d+)?m?s`

const ECHO_SERVICE_MANIFEST = [
  'services:',
  '  - name: svc',
  '    up: echo hello-from-svc',
  '    ready:',
  '      command: { run: "true" }',
  'test: echo tested-ok',
  '',
].join('\n')

describe('registration and disposal', () => {
  it('registers the five tools and disposing the plugin fiber removes them', async () => {
    const { ctx, fiber } = await bootTools(ECHO_SERVICE_MANIFEST)
    for (const name of TOOL_NAMES) expect(ctx.tools.get(name), name).toBeDefined()
    await fiber.dispose()
    for (const name of TOOL_NAMES) expect(ctx.tools.get(name), name).toBeUndefined()
  })

  it('annotates every call for presentation, reads as reads', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    expect(ctx.tools.get('env_up')?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Start the integration-test environment',
      kind: 'execute',
    })
    expect(ctx.tools.get('env_status')?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Check integration-test environment health',
      kind: 'read',
    })
    expect(ctx.tools.get('env_logs')?.presentCall?.({ service: 'svc' })).toEqual({
      card: 'generic',
      title: 'Read svc service logs',
      kind: 'read',
      rawInput: { service: 'svc' },
    })
    expect(ctx.tools.get('env_logs')?.presentCall?.({ service: 'svc', fromOffset: 40 })).toEqual({
      card: 'generic',
      title: 'Read svc service logs',
      kind: 'read',
      rawInput: { service: 'svc', fromOffset: 40 },
    })
    expect(ctx.tools.get('env_down')?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Tear the integration-test environment down',
      kind: 'execute',
    })
    expect(ctx.tools.get('integration_test')?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Run the integration test',
      kind: 'execute',
    })
  })
})

describe('environment tools over real services', () => {
  it('walks the up → status → logs → down loop', async () => {
    const { call } = await bootTools(ECHO_SERVICE_MANIFEST)

    const up = await call('env_up')
    expect(up.isError).toBeFalsy()
    expect(up.text).toMatch(new RegExp(
      `^Environment is up in ${D}; every service is ready\\.\\n\\[ready\\] svc \\(command probe, ready in ${D}\\)$`,
    ))

    const status = await call('env_status')
    expect(status.isError).toBeFalsy()
    expect(status.text).toMatch(new RegExp(
      `^Environment is up; every readiness probe passed just now\\.\\n\\[ready\\] svc \\(command probe, answered in ${D}\\)$`,
    ))

    await waitFor(async () => (await call('env_logs', { service: 'svc' })).text.includes('hello-from-svc'), 'the service output')
    const logs = await call('env_logs', { service: 'svc' })
    expect(logs.isError).toBeFalsy()
    const offset = Number(/\(next offset: (\d+)\)/.exec(logs.text)?.[1])
    expect(offset).toBeGreaterThan(0)
    const delta = await call('env_logs', { service: 'svc', fromOffset: offset })
    expect(delta.text).toBe(`(no new output)\n(next offset: ${offset})`)

    const down = await call('env_down')
    expect(down.isError).toBeFalsy()
    expect(down.text).toBe('Environment is down; no service left residue.')
    const again = await call('env_down')
    expect(again.text).toBe('Environment is down; no service left residue.')
    const idle = await call('env_status')
    expect(idle.text).toBe('The environment is not up; env_up starts it.')
  })

  it('reports a failed startup with the service, the exit facts, and the log tail', async () => {
    const closed = await closedPort()
    const { call } = await bootTools([
      'services:',
      '  - name: bravo',
      '    up: "echo boom-tail; exit 3"',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      'test: echo t',
      '',
    ].join('\n'))

    const up = await call('env_up')
    expect(up.isError).toBeFalsy()
    expect(up.text).toMatch(new RegExp(`Environment failed to start in ${D}; every started service was torn back down\\.`))
    expect(up.text).toContain('[failed] bravo')
    expect(up.text).toContain('its process exited (exit code 3) before it became ready')
    expect(up.text).toContain('  log tail:')
    expect(up.text).toContain('    boom-tail')
  })

  it('propagates a non-manifest engine rejection verbatim', async () => {
    const { call } = await bootTools(ECHO_SERVICE_MANIFEST)
    await call('env_up')
    const second = await call('env_up')
    expect(second.isError).toBe(true)
    expect(second.text).toContain('the environment is up; bring it down before starting it again')
  })

  it('re-probes on env_status and names the decayed service', async () => {
    const { call, root } = await bootTools([
      'services:',
      '  - name: decaying',
      '    up: echo started',
      '    ready:',
      '      command: { run: "test -f ready-flag" }',
      'test: echo t',
      '',
    ].join('\n'))
    await writeFile(join(root, 'ready-flag'), '')

    const up = await call('env_up')
    expect(up.isError).toBeFalsy()
    await unlink(join(root, 'ready-flag'))
    const status = await call('env_status')
    expect(status.isError).toBeFalsy()
    expect(status.text).toMatch(new RegExp([
      '^Environment is up, but not every readiness probe passed just now\\.',
      `\\[failed\\] decaying \\(command probe, answered in ${D}\\)`,
      '  its readiness probe did not pass when re-checked$',
    ].join('\\n')))
  })

  it('rejects unknown services, down-state reads, and negative offsets on env_logs', async () => {
    const { call } = await bootTools(ECHO_SERVICE_MANIFEST)
    const downState = await call('env_logs', { service: 'svc' })
    expect(downState.isError).toBe(true)
    expect(downState.text).toContain('the environment is down; logs are only readable while it is up')

    await call('env_up')
    const unknown = await call('env_logs', { service: 'nope' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('unknown service "nope"; the manifest declares: svc')

    const negative = await call('env_logs', { service: 'svc', fromOffset: -1 })
    expect(negative.isError).toBe(true)
    expect(negative.text).toContain('fromOffset must be a non-negative byte offset, got -1')
  })

  it('folds a failed rollback\'s residue into env_up teardownDetail', async () => {
    const closed = await closedPort()
    const { call } = await bootTools([
      'services:',
      '  - name: messy',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      '    down: "false"',
      '  - name: broken',
      '    up: "echo boom; exit 3"',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      'test: echo t',
      '',
    ].join('\n'))

    const up = await call('env_up')
    expect(up.isError).toBeFalsy()
    expect(up.text).toMatch(new RegExp(`Environment failed to start in ${D}, and rolling the started services back left residue\\.`))
    expect(up.text).toContain('[ready] messy')
    expect(up.text).toContain('[failed] broken')
    expect(up.text).toContain('Rollback residue:')
    expect(up.text).toContain('  service "messy": the down command failed (exit code 1)')
  })

  it('folds teardown residue into env_down detail', async () => {
    const { call } = await bootTools([
      'services:',
      '  - name: messy',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      '    down: "false"',
      'test: echo t',
      '',
    ].join('\n'))

    await call('env_up')
    const down = await call('env_down')
    expect(down.isError).toBeFalsy()
    expect(down.text).toBe([
      'Environment is down, with teardown residue:',
      'service "messy": the down command failed (exit code 1)',
    ].join('\n'))
  })
})

describe('per-call workspace-root resolution from the session cwd', () => {
  it('fails loud on a call without a session working directory, never falling back to the process cwd', async () => {
    const { ctx, call } = await bootTools(ECHO_SERVICE_MANIFEST)
    const anonymous = await callTool(ctx, 'env_up')
    expect(anonymous.isError).toBe(true)
    expect(anonymous.text).toContain('this call carries none')
    expect(anonymous.text).toContain('The harness process cwd is not a fallback')

    const cwdless = await call('env_status', {}, agentFor(ctx, 'testenv-cwdless-caller'))
    expect(cwdless.isError).toBe(true)
    expect(cwdless.text).toContain('its session was created without a cwd')
  })

  it('serves two workspaces from one registration, each caller driving only its own environment', async () => {
    const { ctx, call } = await bootTools(ECHO_SERVICE_MANIFEST)
    const rootB = await mkdtemp(join(tmpdir(), 'testenv-tools-b-'))
    cleanups.push(() => rm(rootB, { recursive: true, force: true }))
    await writeFile(join(rootB, 'testenv.yml'), [
      'services:',
      '  - name: svc-b',
      '    up: echo hello-from-b',
      '    ready:',
      '      command: { run: "true" }',
      'test: echo tested-b',
      '',
    ].join('\n'))
    const callerB = agentFor(ctx, 'testenv-caller-b', rootB)

    expect((await call('env_up')).isError).toBeFalsy()
    expect((await call('env_up', {}, callerB)).isError).toBeFalsy()
    expect((await call('env_status')).text).toContain('[ready] svc ')
    expect((await call('env_status', {}, callerB)).text).toContain('[ready] svc-b ')

    // One workspace's teardown leaves the other's environment untouched.
    expect((await call('env_down')).text).toBe('Environment is down; no service left residue.')
    expect((await call('env_status')).text).toBe('The environment is not up; env_up starts it.')
    expect((await call('env_status', {}, callerB)).text).toContain('Environment is up')
    expect((await call('env_down', {}, callerB)).isError).toBeFalsy()
  })

  it('normalizes the session cwd, so two spellings of one workspace share the engine', async () => {
    const { ctx, root, call } = await bootTools(ECHO_SERVICE_MANIFEST)
    const alias = agentFor(ctx, 'testenv-caller-alias', `${root}/spelled/..`)

    expect((await call('env_up')).isError).toBeFalsy()
    expect((await call('env_status', {}, alias)).text).toContain('Environment is up')
    expect((await call('env_down', {}, alias)).isError).toBeFalsy()
    expect((await call('env_status')).text).toBe('The environment is not up; env_up starts it.')
  })
})

describe('manifest defects point at the bootstrap skill', () => {
  it('surfaces a missing manifest with the absolute path resolved from the session cwd, and the repair pointer', async () => {
    const { call, root } = await bootTools(undefined)
    const up = await call('env_up')
    expect(up.isError).toBe(true)
    expect(up.text).toContain(`testenv manifest ${join(root, 'testenv.yml')} is invalid`)
    expect(up.text).toContain('the manifest file cannot be read')
    expect(up.text).toContain('Run the `testenv-bootstrap` skill')
  })

  it('keeps every field-path issue verbatim ahead of the pointer', async () => {
    const { call } = await bootTools([
      'services:',
      '  - name: preview',
      '    kind: static',
      '    up: serve dist',
      '    ready:',
      '      command: { run: "true" }',
      '',
    ].join('\n'))

    const report = await call('integration_test')
    expect(report.isError).toBe(true)
    expect(report.text).toContain("services[0].kind: 'static' services are reserved for future static preview hosting")
    expect(report.text).toContain('test must be a non-empty string')
    expect(report.text).toContain('Run the `testenv-bootstrap` skill to research how this project\'s services start and to write or repair testenv.yml.')
  })
})

describe('integration_test over real services', () => {
  it('reports a pass with the exit code and output tail, leaving the environment up', async () => {
    const { call } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'seed: echo seeded',
      'test: echo tested-ok',
      '',
    ].join('\n'))

    const report = await call('integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`^Integration test passed \\(exit code 0\\) in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(`Environment: started by this run in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(`\\[ready\\] svc \\(command probe, ready in ${D}\\)`))
    expect(report.text).toMatch(new RegExp(`Phases:\\n {2}✓ up ${D}\\n {2}✓ seed ${D}\\n {2}✓ test ${D}`))
    expect(report.text).toContain('--- output tail ---')
    expect(report.text).toContain('tested-ok')
    const status = await call('env_status')
    expect(status.text).toContain('Environment is up')
  })

  it('names a failing seed phase with its exit code and tail', async () => {
    const { call } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'seed: "echo seed-broke; exit 5"',
      'test: echo never-reached',
      '',
    ].join('\n'))

    const report = await call('integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`Integration test failed during the seed phase \\(exit code 5\\) in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(` {2}✗ seed ${D}`))
    expect(report.text).not.toMatch(/[✓✗] test /)
    expect(report.text).toContain('seed-broke')
    expect(report.text).not.toContain('never-reached')
  })

  it('reports a deadline-cut test with the timeout detail and no exit code', async () => {
    const { call } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'test: sleep 60',
      '',
    ].join('\n'), { testTimeoutMs: 300, graceMs: 100 })

    const report = await call('integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`Integration test failed during the test phase in ${D}\\.`))
    expect(report.text).toContain('the test command timed out after 300ms and was terminated')
    expect(report.text).not.toContain('(exit code')
  })

  it('reports a failed up phase with the per-service startup state', async () => {
    const closed = await closedPort()
    const { call } = await bootTools([
      'services:',
      '  - name: broken',
      '    up: exit 3',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      '  - name: waiting',
      '    up: echo never-started',
      '    ready:',
      '      command: { run: "true" }',
      'test: echo never',
      '',
    ].join('\n'))

    const report = await call('integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`Integration test failed in ${D}: the environment did not start\\.`))
    expect(report.text).toContain('[failed] broken (tcp probe)')
    expect(report.text).toContain('[not-started] waiting (command probe)')
  })

  it('leads a failing test with the phase and duration, and puts the runner summary ahead of the tail', async () => {
    const { call } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'test: "echo scenario-noise; echo \'==================== 2 failed, 3 passed in 0.12s ====================\'; exit 1"',
      '',
    ].join('\n'))

    const report = await call('integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`^Integration test failed during the test phase \\(exit code 1\\) in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(`\\[ready\\] svc \\(command probe, ready in ${D}\\)`))
    expect(report.text).toMatch(new RegExp(` {2}✗ test ${D}`))
    expect(report.text).toContain('Runner summary: ==================== 2 failed, 3 passed in 0.12s ====================')
    expect(report.text.indexOf('Runner summary:')).toBeLessThan(report.text.indexOf('--- output tail ---'))
  })

  it('marks the environment as started by a fresh run and as reused on a re-run', async () => {
    const { call } = await bootTools(ECHO_SERVICE_MANIFEST)

    const first = await call('integration_test')
    expect(first.text).toMatch(new RegExp(`Environment: started by this run in ${D}\\.`))
    expect(first.text).toMatch(new RegExp(` {2}✓ up ${D}`))

    const second = await call('integration_test')
    expect(second.text).toMatch(new RegExp(`Environment: reused \\(up ${D} ago\\)\\.`))
    expect(second.text).not.toMatch(/[✓✗] up /)
  })
})

describe('integration_test in the background over a real job registry', () => {
  /**
   * Every background job is owned now: the caller must carry a session cwd
   * for the root, and the same `exec.agent` becomes the job's owner, so every
   * registry read passes the caller through the ownership fence.
   */
  async function startBackground(env: Pick<ToolsEnv, 'call'>, caller?: Agent): Promise<JobId> {
    const started = await env.call('integration_test', { run_in_background: true }, caller)
    expect(started.isError).toBeFalsy()
    expect(started.text).toMatch(new RegExp(
      '^Started background job testenv-integration-\\d+ for the integration test; follow it with job_output '
      + '\\(phase markers, live test output, then the final report\\), and stop it with job_kill\\.$',
    ))
    return JobId(/job (testenv-integration-\d+)/.exec(started.text)![1])
  }

  /** Poll the job's consuming read into an accumulator until it contains `needle`. */
  async function readJobUntil(ctx: Context, id: JobId, caller: Agent, state: { text: string }, needle: string): Promise<void> {
    await waitFor(() => {
      state.text += ctx.jobs.read(id, caller).text
      return state.text.includes(needle)
    }, `job output containing ${JSON.stringify(needle)}`)
  }

  const GATED_MANIFEST = [
    'services:',
    '  - name: svc',
    '    up: echo hello-from-svc',
    '    ready:',
    '      command: { run: "true" }',
    'seed: echo seeded',
    'test: "echo integration-line; while [ ! -f go ]; do sleep 0.05; done"',
    '',
  ].join('\n')

  it('returns the job id immediately, owned by the caller, streams markers and live output, and ends with the synchronous render', async () => {
    const env = await bootTools(GATED_MANIFEST, {}, { jobs: true })
    const { ctx, root, agent } = env
    const id = await startBackground(env)
    expect(ctx.jobs.get(id, agent)).toMatchObject({ kind: 'testenv-integration', label: 'integration test', status: 'running' })
    // The calling agent owns the job: root resolution requires an owning session, and the same session owns the run.
    expect(ctx.jobs.get(id, agent).ownerSession).toBe(agent.id)

    // Live reads while the test process is still gated on the go file.
    const seen = { text: '' }
    await readJobUntil(ctx, id, agent, seen, 'integration-line')
    expect(ctx.jobs.get(id, agent).status).toBe('running')
    expect(seen.text).toContain('[up] starting service "svc" (1/1)')
    expect(seen.text).toContain('[up] every service is ready')
    expect(seen.text).toContain('[seed] done (exit code 0)')
    expect(seen.text).toContain('[test] running:')

    await writeFile(join(root, 'go'), '')
    const settled = await ctx.jobs.wait(id, 10_000, agent)
    expect(settled).toMatchObject({ status: 'completed', detail: 'passed' })

    // The settling read delivers the marker and then the final render.
    seen.text += ctx.jobs.read(id, agent).text
    expect(seen.text).toContain('[test] settled (exit code 0)')
    const trailer = seen.text.slice(seen.text.indexOf('Integration test ')).replace(/\n$/, '')
    expect(trailer).toMatch(/^Integration test passed \(exit code 0\)/)
    expect(trailer).toContain('Environment: started by this run')

    // The very same render as a synchronous run of the same manifest, timings aside.
    const twin = await bootTools(GATED_MANIFEST)
    await writeFile(join(twin.root, 'go'), '')
    const sync = await twin.call('integration_test')
    expect(sync.isError).toBeFalsy()
    expect(stripDurations(trailer)).toBe(stripDurations(sync.text))
  })

  it('reports a red test as a completed job whose output is the synchronous failure render', async () => {
    const failing = [
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'test: "echo scenario-noise; echo \'==================== 2 failed, 3 passed in 0.12s ====================\'; exit 1"',
      '',
    ].join('\n')
    const env = await bootTools(failing, {}, { jobs: true })
    const { ctx, agent } = env
    const id = await startBackground(env)
    const settled = await ctx.jobs.wait(id, 10_000, agent)
    expect(settled).toMatchObject({ status: 'completed', detail: 'failed during the test phase' })

    const text = ctx.jobs.read(id, agent).text
    const trailer = text.slice(text.indexOf('Integration test ')).replace(/\n$/, '')
    expect(trailer).toMatch(/^Integration test failed during the test phase \(exit code 1\)/)
    expect(trailer).toContain('Runner summary: ==================== 2 failed, 3 passed in 0.12s ====================')

    const twin = await bootTools(failing)
    const sync = await twin.call('integration_test')
    expect(stripDurations(trailer)).toBe(stripDurations(sync.text))
  })

  it('job_kill maps to killed and tears the run-raised environment down with no residue', async () => {
    const env = await bootTools([
      'services:',
      '  - name: alpha',
      '    up: node idle.cjs alpha.pid alpha',
      '    ready:',
      '      command: { run: "test -f alpha.pid" }',
      'test: node idle.cjs test.pid test-child',
      '',
    ].join('\n'), { graceMs: 100 }, { jobs: true })
    const { ctx, root, agent } = env
    await writeFile(join(root, 'idle.cjs'), [
      "require('fs').writeFileSync(process.argv[2], String(process.pid))",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))

    const id = await startBackground(env)
    let testPid = 0
    await waitFor(async () => {
      try {
        testPid = Number((await readFile(join(root, 'test.pid'), 'utf8')).trim())
      } catch {
        // ENOENT until the test child writes its pid file; the deadline bounds the wait.
        return false
      }
      return Number.isInteger(testPid) && testPid > 0
    }, 'the test child pid file')

    expect(ctx.jobs.kill(id, agent)).toBe('requested')
    const settled = await ctx.jobs.wait(id, 10_000, agent)
    expect(settled).toMatchObject({ status: 'killed', detail: 'the run was cancelled' })

    await waitFor(() => !alive(testPid), 'the killed test process to exit')
    expect((await env.call('env_status')).text).toBe('The environment is not up; env_up starts it.')
    const text = ctx.jobs.read(id, agent).text
    expect(text).toContain('[cancelled] tearing the environment down')
    expect(text).toContain('Integration test failed during the test phase')
    expect(text).toContain('the test command was cancelled and its process tree was terminated')
  })

  it('owns the job with the calling agent, fencing reads to that session', async () => {
    const env = await bootTools(GATED_MANIFEST, {}, { jobs: true })
    const { ctx, root } = env
    await writeFile(join(root, 'go'), '')
    const owner = agentFor(ctx, 'testenv-bg-owner', root)

    const id = await startBackground(env, owner)
    expect(ctx.jobs.get(id, owner).ownerSession).toBe(owner.id)
    expect(() => ctx.jobs.read(id)).toThrow('belongs to another session')
    const settled = await ctx.jobs.wait(id, 10_000, owner)
    expect(settled).toMatchObject({ status: 'completed', detail: 'passed' })
  })

  it('fails the job — not the test — when the run itself breaks, pointing manifest defects at the skill', async () => {
    const env = await bootTools(undefined, {}, { jobs: true })
    const id = await startBackground(env)
    const settled = await env.ctx.jobs.wait(id, 10_000, env.agent)
    expect(settled.status).toBe('failed')
    expect(settled.detail).toContain('testenv manifest')
    expect(settled.detail).toContain('Run the `testenv-bootstrap` skill')
  })

  it('fails the job with the raw error when the observed run rejects for a non-manifest defect', async () => {
    const engine = {
      runTestObserved: () => ({
        done: Promise.reject(new Error('engine broke')),
        readOutput: () => '',
        cancel: () => {},
      }),
    } as unknown as TestenvEngine
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, {})
    ctx.jobs.attachController('spec-controller')
    await ctx.plugin({
      inject: ['tools'],
      apply: (child: Context) => { registerTools(child, () => engine) },
    })
    const agent = agentFor(ctx, 'testenv-fake-engine-caller', tmpdir())

    const id = await startBackground({ call: (name, args = {}, caller = agent) => callTool(ctx, name, args, caller) })
    const settled = await ctx.jobs.wait(id, 10_000, agent)
    expect(settled).toMatchObject({ status: 'failed', detail: 'engine broke' })
    expect(ctx.jobs.read(id, agent).text).toBe('')
  })

  it('refuses run_in_background without a jobs service, naming the synchronous way out', async () => {
    const { call } = await bootTools(ECHO_SERVICE_MANIFEST)
    const result = await call('integration_test', { run_in_background: true })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('run_in_background is unavailable: this composition has no background-job service.')
    expect(result.text).toContain('call integration_test without run_in_background to run synchronously')
  })

  it('propagates the registry refusal verbatim when no controller is attached, appending the synchronous way out', async () => {
    const { call } = await bootTools(ECHO_SERVICE_MANIFEST, {}, { jobs: true, controller: false })
    const result = await call('integration_test', { run_in_background: true })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no job controller serves this agent')
    expect(result.text).toContain('\nCall integration_test without run_in_background to run synchronously.')
  })

  it('run_in_background: false stays the synchronous path, byte for byte', async () => {
    const { call } = await bootTools(ECHO_SERVICE_MANIFEST, {}, { jobs: true })
    const explicit = await call('integration_test', { run_in_background: false })
    expect(explicit.isError).toBeFalsy()
    await call('env_down')
    const omitted = await call('integration_test')
    expect(omitted.isError).toBeFalsy()
    await call('env_down')
    expect(stripDurations(explicit.text)).toBe(stripDurations(omitted.text))
    expect(explicit.text).toMatch(new RegExp(`^Integration test passed \\(exit code 0\\) in ${D}\\.`))
  })
})

describe('render branches only a crafted value reaches', () => {
  it('omits the log-tail block for an empty tail', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    const text = renderText(ctx, 'env_up', {
      ok: false,
      services: [{ name: 'svc', state: 'failed', detail: 'spawn failed', logTail: '' }],
    })
    expect(text).toBe([
      'Environment failed to start; every started service was torn back down.',
      '[failed] svc',
      '  spawn failed',
    ].join('\n'))
  })

  it('marks a lossy log read', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    const text = renderText(ctx, 'env_logs', { text: 'tail-part', nextOffset: 9, lossy: true })
    expect(text).toBe([
      '(the in-memory tail overflowed; earlier output was dropped)',
      'tail-part',
      '(next offset: 9)',
    ].join('\n'))
  })

  it('falls back when residue detail is absent', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    expect(renderText(ctx, 'env_down', { ok: false }))
      .toBe('Environment is down, with teardown residue:\n(unreported)')
  })

  it('renders a service-less up failure and a tail-less pass of integration_test', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    expect(renderText(ctx, 'integration_test', { passed: false, phase: 'up' }))
      .toBe('Integration test failed: the environment did not start.')
    expect(renderText(ctx, 'integration_test', { passed: true, phase: 'test', exitCode: 0, outputTail: '' }))
      .toBe('Integration test passed (exit code 0).')
    expect(renderText(ctx, 'integration_test', { passed: false, phase: 'test' }))
      .toBe('Integration test failed during the test phase.')
  })

  it('renders a report with no timing facts without placeholders, and scales durations', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    expect(renderText(ctx, 'env_up', { ok: true, services: [{ name: 'svc', state: 'ready', probe: 'tcp', readyAfterMs: 1234 }] }))
      .toBe('Environment is up; every service is ready.\n[ready] svc (tcp probe, ready in 1.2s)')
    expect(renderText(ctx, 'integration_test', {
      passed: true,
      phase: 'test',
      exitCode: 0,
      outputTail: '',
      envReused: true,
      envUpAgeMs: 312_000,
    })).toBe('Integration test passed (exit code 0).\nEnvironment: reused (up 5m12s ago).')
    expect(renderText(ctx, 'integration_test', { passed: true, phase: 'test', exitCode: 0, outputTail: '', envReused: true }))
      .toBe('Integration test passed (exit code 0).\nEnvironment: reused.')
    expect(renderText(ctx, 'integration_test', { passed: true, phase: 'test', exitCode: 0, outputTail: '', envReused: false }))
      .toBe('Integration test passed (exit code 0).\nEnvironment: started by this run.')
  })

  it('extracts vitest and jest summary lines, preferring the last matching one, and omits unmatched tails', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    const last = renderText(ctx, 'integration_test', {
      passed: false,
      phase: 'test',
      exitCode: 1,
      outputTail: 'Tests: 2 failed, 5 passed, 7 total\nnoise\n2 failed, 5 passed in 0.42s\ntrailer',
    })
    expect(last).toContain('Runner summary: 2 failed, 5 passed in 0.42s')
    const vitest = renderText(ctx, 'integration_test', {
      passed: true,
      phase: 'test',
      exitCode: 0,
      outputTail: ' Tests  6 passed (6)\n Duration  1.2s',
    })
    expect(vitest).toContain('Runner summary: Tests  6 passed (6)')
    const unmatched = renderText(ctx, 'integration_test', {
      passed: false,
      phase: 'test',
      exitCode: 1,
      outputTail: 'boom\nno summary lines here',
      durationMs: 42,
    })
    expect(unmatched).not.toContain('Runner summary:')
    expect(unmatched).toContain('--- output tail ---')
  })
})

describe('projection of reports from an engine without timing facts', () => {
  it('keeps earlier report shapes renderable with no timing noise', async () => {
    const engine = {
      up: () => ({ ok: true, services: [{ name: 'svc', state: 'ready' }] }),
      status: () => ({ state: 'up', services: [{ name: 'svc', ready: true }] }),
      runTest: () => ({ phase: 'test', passed: true, exitCode: 0, outputTail: '' }),
    } as unknown as TestenvEngine
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin({
      inject: ['tools'],
      apply: (child: Context) => { registerTools(child, () => engine) },
    })
    const agent = agentFor(ctx, 'testenv-plain-report-caller', tmpdir())

    expect((await callTool(ctx, 'env_up', {}, agent)).text).toBe('Environment is up; every service is ready.\n[ready] svc')
    expect((await callTool(ctx, 'env_status', {}, agent)).text).toBe('Environment is up; every readiness probe passed just now.\n[ready] svc')
    expect((await callTool(ctx, 'integration_test', {}, agent)).text).toBe('Integration test passed (exit code 0).')
  })
})
