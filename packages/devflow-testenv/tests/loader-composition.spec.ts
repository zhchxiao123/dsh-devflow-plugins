// REAL-composition proof: a cordis.yml booted through the actual Loader mounts
// the subprocess runtime, the tool runtime, the skill registry, the agent
// registry, and this plugin, then the registered tools drive a real
// two-service environment for the calling session's workspace — the root
// resolves per call from that session's cwd, two sessions in different
// workspaces get isolated environments, render output the model sees, pid
// files and seed markers on disk, and no surviving service process after
// env_down or after disposing the fiber (the zero-orphan guarantee across
// every workspace, proven through the Loader). A workspace without a manifest
// gets the fail-loud error pointing at the bundled skill, which the same boot
// lists and loads.
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as Testenv from '@zhchxiao123/dsh-devflow-testenv'

// Module-local declaration of the `process` members this suite touches: the
// type-aware linter resolves the @types/node `process` global
// nondeterministically in this workspace, and a local declaration keeps its
// verdict stable. Runtime still binds the real global.
declare const process: { kill(pid: number, signal: number): boolean }

const cleanups: (() => Promise<unknown>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A currently-free loopback port: bind to 0, read the assignment, release. */
async function freePort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) })
  })
  await new Promise((resolve) => { server.close(resolve) })
  return port
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

/**
 * Liveness that counts a zombie as dead: the torn-down node grandchildren
 * reparent to a container init that reaps lazily, and `kill(pid, 0)` answers
 * success for a zombie.
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

async function pidFrom(root: string, file: string): Promise<number> {
  let pid = 0
  await waitFor(async () => {
    try {
      pid = Number((await readFile(join(root, file), 'utf8')).trim())
    } catch {
      // ENOENT until the service writes its pid file; the deadline bounds the wait.
      return false
    }
    return Number.isInteger(pid) && pid > 0
  }, `the ${file} pid file`)
  return pid
}

/**
 * A tmp workspace holding the fake services: a long-lived TCP listener and a
 * long-lived HTTP health endpoint (each recording its pid for liveness
 * assertions), a seed command that leaves a marker file, and a test command
 * that exercises the running HTTP service for real.
 */
async function writeWorkspace(): Promise<{ root: string; tcpPort: number; httpPort: number }> {
  const root = await mkdtemp(join(tmpdir(), 'testenv-loader-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const [tcpPort, httpPort] = [await freePort(), await freePort()]
  await writeFile(join(root, 'tcp-service.cjs'), [
    "const { writeFileSync } = require('node:fs')",
    "const { createServer } = require('node:net')",
    'const [, , portArg, pidFile] = process.argv',
    'writeFileSync(pidFile, String(process.pid))',
    'const server = createServer(() => {})',
    "server.listen(Number(portArg), '127.0.0.1', () => { console.log('tcp-service listening') })",
    '',
  ].join('\n'))
  await writeFile(join(root, 'http-service.cjs'), [
    "const { writeFileSync } = require('node:fs')",
    "const { createServer } = require('node:http')",
    'const [, , portArg, pidFile] = process.argv',
    'writeFileSync(pidFile, String(process.pid))',
    'const server = createServer((request, response) => {',
    "  response.statusCode = request.url === '/healthz' ? 200 : 404",
    '  response.end()',
    '})',
    "server.listen(Number(portArg), '127.0.0.1', () => { console.log('http-service listening') })",
    '',
  ].join('\n'))
  await writeFile(join(root, 'seed.cjs'), "require('node:fs').writeFileSync('seeded.marker', 'seeded\\n')\n")
  await writeFile(join(root, 'check-env.cjs'), [
    "const { get } = require('node:http')",
    'const [, , url] = process.argv',
    'get(url, (response) => {',
    '  response.resume()',
    '  console.log(`integration-ok ${response.statusCode}`)',
    '  process.exitCode = response.statusCode === 200 ? 0 : 1',
    "}).on('error', (error) => {",
    '  console.error(error.message)',
    '  process.exitCode = 1',
    '})',
    '',
  ].join('\n'))
  await writeFile(join(root, 'testenv.yml'), [
    'services:',
    '  - name: tcp-svc',
    `    up: node tcp-service.cjs ${tcpPort} tcp.pid`,
    '    ready:',
    `      tcp: { port: ${tcpPort} }`,
    '  - name: http-svc',
    `    up: node http-service.cjs ${httpPort} http.pid`,
    '    ready:',
    `      http: { url: "http://127.0.0.1:${httpPort}/healthz", status: 200 }`,
    'seed: node seed.cjs',
    `test: node check-env.cjs http://127.0.0.1:${httpPort}/healthz`,
    '',
  ].join('\n'))
  return { root, tcpPort, httpPort }
}

async function boot(root: string): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-jobs-local'",
    "- name: '@zhchxiao123/dsh-devflow-testenv'",
    '  config:',
    '    readyPollIntervalMs: 25',
    '    defaultReadyTimeoutMs: 10000',
    '    graceMs: 300',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  // The tool runtime injects the system-prompt service; the real provider
  // package is not resolvable in this workspace, so the boot provides the one
  // member the runtime touches — the same stub the unit suites use.
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry],
    ['@zhchxiao123/dsh-devflow-testenv', Testenv],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  // The workspace root resolves per call from the calling session's cwd, so
  // the boot never touches the process cwd — the process may sit anywhere
  // (in a real deployment: the harness checkout).
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** The registered-agent fixture from the devflow-tool composition suite, with the session cwd the tools resolve the root from. */
function sessionIn(ctx: Context, root: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(`loader-session-${basename(root)}`)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: root })
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

function resultText(result: { content: unknown }): string {
  const content = result.content as { type: string; text?: string }[]
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function call(ctx: Context, name: string, args: object = {}, agent?: Agent): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `testenv-loader-${name}-${Math.random()}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return { isError: result.isError, text: resultText(result) }
}

describe('testenv real Loader composition through cordis.yml', () => {
  it('drives up → status → logs → integration_test → down over real services', async () => {
    const { root } = await writeWorkspace()
    const ctx = await boot(root)
    const caller = sessionIn(ctx, root)

    const up = await call(ctx, 'env_up', {}, caller)
    expect(up.isError).toBeFalsy()
    const duration = String.raw`\d+(?:\.\d+)?m?s`
    expect(up.text).toMatch(new RegExp([
      `^Environment is up in ${duration}; every service is ready\\.`,
      `\\[ready\\] tcp-svc \\(tcp probe, ready in ${duration}\\)`,
      `\\[ready\\] http-svc \\(http probe, ready in ${duration}\\)$`,
    ].join('\\n')))
    const tcpPid = await pidFrom(root, 'tcp.pid')
    const httpPid = await pidFrom(root, 'http.pid')
    expect(alive(tcpPid)).toBe(true)
    expect(alive(httpPid)).toBe(true)

    const status = await call(ctx, 'env_status', {}, caller)
    expect(status.isError).toBeFalsy()
    expect(status.text).toMatch(new RegExp([
      '^Environment is up; every readiness probe passed just now\\.',
      `\\[ready\\] tcp-svc \\(tcp probe, answered in ${duration}\\)`,
      `\\[ready\\] http-svc \\(http probe, answered in ${duration}\\)$`,
    ].join('\\n')))

    await waitFor(async () => (await call(ctx, 'env_logs', { service: 'tcp-svc' }, caller)).text.includes('tcp-service listening'), 'the tcp service log')
    const logs = await call(ctx, 'env_logs', { service: 'tcp-svc' }, caller)
    expect(logs.isError).toBeFalsy()
    expect(logs.text).toContain('tcp-service listening')
    expect(logs.text).toMatch(/\(next offset: \d+\)/)

    const report = await call(ctx, 'integration_test', {}, caller)
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`Integration test passed \\(exit code 0\\) in ${duration}\\.`))
    expect(report.text).toContain('Environment: reused (up ')
    expect(report.text).toContain('integration-ok 200')
    // The seed command ran between up and test, in the workspace root.
    await expect(readFile(join(root, 'seeded.marker'), 'utf8')).resolves.toBe('seeded\n')

    const down = await call(ctx, 'env_down', {}, caller)
    expect(down.isError).toBeFalsy()
    expect(down.text).toBe('Environment is down; no service left residue.')
    await waitFor(() => !alive(tcpPid) && !alive(httpPid), 'both service processes to exit')
    expect((await call(ctx, 'env_status', {}, caller)).text).toBe('The environment is not up; env_up starts it.')
  }, 30_000)

  it('leaves no service process behind when the fiber is disposed with the environment up', async () => {
    const { root } = await writeWorkspace()
    const ctx = await boot(root)
    const caller = sessionIn(ctx, root)

    const up = await call(ctx, 'env_up', {}, caller)
    expect(up.isError).toBeFalsy()
    const tcpPid = await pidFrom(root, 'tcp.pid')
    const httpPid = await pidFrom(root, 'http.pid')
    expect(alive(tcpPid)).toBe(true)
    expect(alive(httpPid)).toBe(true)

    await ctx.fiber.dispose()
    context = undefined
    await waitFor(() => !alive(tcpPid) && !alive(httpPid), 'both service processes to exit after disposal')
  }, 30_000)

  it('serves two session workspaces at once, isolates their teardowns, and disposes every environment with the fiber', async () => {
    const a = await writeWorkspace()
    const b = await writeWorkspace()
    const ctx = await boot(a.root)
    const callerA = sessionIn(ctx, a.root)
    const callerB = sessionIn(ctx, b.root)

    // Both sessions bring their own environment up through the same tools.
    expect((await call(ctx, 'env_up', {}, callerA)).isError).toBeFalsy()
    expect((await call(ctx, 'env_up', {}, callerB)).isError).toBeFalsy()
    const aPids = [await pidFrom(a.root, 'tcp.pid'), await pidFrom(a.root, 'http.pid')]
    const bPids = [await pidFrom(b.root, 'tcp.pid'), await pidFrom(b.root, 'http.pid')]
    for (const pid of [...aPids, ...bPids]) expect(alive(pid)).toBe(true)

    // A's teardown is invisible to B: A's services exit, B's stay up and healthy.
    expect((await call(ctx, 'env_down', {}, callerA)).text).toBe('Environment is down; no service left residue.')
    await waitFor(() => aPids.every(pid => !alive(pid)), "workspace A's services to exit")
    for (const pid of bPids) expect(alive(pid)).toBe(true)
    expect((await call(ctx, 'env_status', {}, callerA)).text).toBe('The environment is not up; env_up starts it.')
    expect((await call(ctx, 'env_status', {}, callerB)).text).toContain('Environment is up')

    // With both environments up, one fiber disposal tears every workspace down.
    // The stale pid files go first, so pidFrom reads the second run's pids.
    await rm(join(a.root, 'tcp.pid'))
    await rm(join(a.root, 'http.pid'))
    expect((await call(ctx, 'env_up', {}, callerA)).isError).toBeFalsy()
    const aSecondPids = [await pidFrom(a.root, 'tcp.pid'), await pidFrom(a.root, 'http.pid')]
    await ctx.fiber.dispose()
    context = undefined
    await waitFor(() => [...aSecondPids, ...bPids].every(pid => !alive(pid)), 'every workspace service to exit after disposal')
  }, 45_000)

  it('runs integration_test as a background job through the Loader-booted registry', async () => {
    const { root } = await writeWorkspace()
    const ctx = await boot(root)
    const caller = sessionIn(ctx, root)
    // The controller role dsh-tool-jobs plays in a product composition.
    ctx.jobs.attachController('loader-spec')

    const started = await call(ctx, 'integration_test', { run_in_background: true }, caller)
    expect(started.isError).toBeFalsy()
    expect(started.text).toMatch(/^Started background job testenv-integration-\d+ for the integration test/)
    const id = JobId(/job (testenv-integration-\d+)/.exec(started.text)![1])

    // The calling session owns the job, so every registry read passes it.
    const settled = await ctx.jobs.wait(id, 20_000, caller)
    expect(settled).toMatchObject({ kind: 'testenv-integration', status: 'completed', detail: 'passed' })
    const text = ctx.jobs.read(id, caller).text
    expect(text).toContain('[up] starting service "tcp-svc" (1/2)')
    expect(text).toContain('[up] service "http-svc" is ready')
    expect(text).toContain('integration-ok 200')
    expect(text).toContain('[test] settled (exit code 0)')
    expect(text).toMatch(/Integration test passed \(exit code 0\) in \d+(?:\.\d+)?m?s\./)
    await expect(readFile(join(root, 'seeded.marker'), 'utf8')).resolves.toBe('seeded\n')

    const down = await call(ctx, 'env_down', {}, caller)
    expect(down.isError).toBeFalsy()
  }, 30_000)

  it('points a manifest-less workspace at the bundled skill, which the boot lists and loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'testenv-loader-empty-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = await boot(root)
    const caller = sessionIn(ctx, root)

    const up = await call(ctx, 'env_up', {}, caller)
    expect(up.isError).toBe(true)
    expect(up.text).toContain(`testenv manifest ${join(root, 'testenv.yml')} is invalid`)
    expect(up.text).toContain('the manifest file cannot be read')
    expect(up.text).toContain('Run the `testenv-bootstrap` skill')

    const catalog = await ctx.skills.list()
    expect(catalog.some(entry => entry.name === 'testenv-bootstrap')).toBe(true)
    const skill = await ctx.skills.get('testenv-bootstrap')
    expect(skill?.provider).toBe('testenv-bootstrap')
    expect(skill?.content).toContain('## 1. Research how the environment starts')
  }, 30_000)
})
