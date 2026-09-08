/**
 * The environment state machine over real child processes: ordered startup,
 * the one up-command rule (probe pass = ready, failing exit before ready =
 * failure), reverse rollback with no surviving process, both teardown paths,
 * re-probing status, offset-based logs that outlive their process, the
 * up→seed→test ladder, and teardown through fiber disposal. Real specs run
 * `LocalSubprocessRuntime` with real `sh`/`node` children because tree
 * termination and post-exit readability are provider semantics a double
 * cannot honestly vouch for; a scripted double covers only the branches a
 * real process cannot reach deterministically (spawn-level rejections, a
 * tree that refuses to exit, in-flight state guards).
 */
import { readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server as TcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { TestenvEngine } from '../src/engine.ts'
import { ManifestError } from '../src/manifest.ts'
import type { EngineHost, EngineSettings, SubprocessSpawner } from '../src/types.ts'

// Module-local declaration of the one `process` member this suite touches:
// the type-aware linter resolves the @types/node `process` global (and the
// `node:process` module) nondeterministically in this workspace, and a local
// declaration keeps its verdict stable. Runtime still binds the real global.
declare const process: { readonly platform: string; kill(pid: number, signal: number): true }

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** The `expect.any(Number)` matcher in a number-typed position; the matcher itself is typed `any`. */
function aNumber(): number {
  return expect.any(Number) as number
}

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
 * Liveness that counts a zombie as dead: this suite's orphaned grandchildren
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

async function pidIn(path: string): Promise<number> {
  let pid = 0
  await waitFor(async () => {
    try {
      pid = Number((await readFile(path, 'utf8')).trim())
    } catch {
      // The service has not written its pid file yet; keep polling.
      return false
    }
    return Number.isInteger(pid) && pid > 0
  }, `pid file ${path}`)
  return pid
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // Swallows ENOENT — absence is the answer this helper exists to report.
    return false
  }
}

function listen(server: ReturnType<typeof createHttpServer> | TcpServer): Promise<number> {
  cleanups.push(() => new Promise((resolve) => { server.close(resolve) }))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) })
  })
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

/** A fake service: writes its pid, prints two observable lines, then idles. */
const IDLE_SCRIPT = [
  "require('fs').writeFileSync(process.argv[2], String(process.pid))",
  "console.log('hello from ' + process.argv[3])",
  "console.log('mark=' + (process.env.TESTENV_MARK || 'none'))",
  'setInterval(() => {}, 1000)',
  '',
].join('\n')

const EXIT_SCRIPT = [
  "require('fs').writeFileSync(process.argv[2], String(process.pid))",
  "console.log('clean exit')",
  '',
].join('\n')

const PWD_SCRIPT = 'console.log(process.cwd())\n'

interface RealEnv {
  ctx: Context
  engine: TestenvEngine
  root: string
}

async function bootReal(manifest: string | undefined, overrides: Partial<EngineSettings> = {}): Promise<RealEnv> {
  const root = await mkdtemp(join(tmpdir(), 'testenv-engine-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  if (manifest !== undefined) await writeFile(join(root, 'testenv.yml'), manifest)
  await writeFile(join(root, 'idle.cjs'), IDLE_SCRIPT)
  await writeFile(join(root, 'exit.cjs'), EXIT_SCRIPT)
  await writeFile(join(root, 'pwd.cjs'), PWD_SCRIPT)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return { ctx, engine: new TestenvEngine(ctx, settings(root, overrides)), root }
}

describe('up and down over real processes', () => {
  it('starts services in order, reports ready, and tears down through the registered effect', async () => {
    const p1 = await listen(createTcpServer(() => {}))
    const p2 = await listen(createHttpServer((_req, res) => {
      res.statusCode = 204
      res.end()
    }))
    const { engine, root } = await bootReal([
      'services:',
      '  - name: alpha',
      '    up: node idle.cjs alpha.pid alpha',
      '    ready:',
      `      tcp: { port: ${p1} }`,
      '    down: touch alpha-down',
      '  - name: beta',
      '    up: node idle.cjs beta.pid beta',
      '    ready:',
      `      http: { url: "http://127.0.0.1:${p2}/healthz" }`,
      '    env:',
      '      TESTENV_MARK: beta-mark',
      'test: echo top-test',
      '',
    ].join('\n'))

    const report = await engine.up()
    expect(report).toEqual({
      ok: true,
      durationMs: aNumber(),
      services: [
        { name: 'alpha', state: 'ready', probe: 'tcp', readyAfterMs: aNumber() },
        { name: 'beta', state: 'ready', probe: 'http', readyAfterMs: aNumber() },
      ],
    })
    expect(engine.state).toBe('up')
    const alphaPid = await pidIn(join(root, 'alpha.pid'))
    const betaPid = await pidIn(join(root, 'beta.pid'))
    expect(alive(alphaPid)).toBe(true)
    expect(alive(betaPid)).toBe(true)

    await expect(engine.status()).resolves.toEqual({
      state: 'up',
      services: [
        { name: 'alpha', ready: true, probe: 'tcp', probeMs: aNumber() },
        { name: 'beta', ready: true, probe: 'http', probeMs: aNumber() },
      ],
    })

    // The manifest env layers over the scrubbed parent environment.
    await waitFor(() => engine.logs('beta').text.includes('mark=beta-mark'), 'beta output')
    await waitFor(() => engine.logs('alpha').text.includes('hello from alpha'), 'alpha output')
    const first = engine.logs('alpha')
    const delta = engine.logs('alpha', first.nextOffset)
    expect(delta).toMatchObject({ text: '', nextOffset: first.nextOffset, lossy: false })
    expect(() => engine.logs('nope')).toThrow('unknown service "nope"; the manifest declares: alpha, beta')

    await expect(engine.down()).resolves.toEqual({ ok: true, failures: [] })
    expect(engine.state).toBe('down')
    expect(await exists(join(root, 'alpha-down'))).toBe(true)
    expect(alive(alphaPid)).toBe(false)
    expect(alive(betaPid)).toBe(false)
    await expect(engine.down()).resolves.toEqual({ ok: true, failures: [] })
    expect(() => engine.logs('alpha')).toThrow('the environment is down; logs are only readable while it is up')
    await expect(engine.status()).resolves.toEqual({ state: 'down', services: [] })
  })

  it('treats a probe pass after a clean process exit as ready, and status re-probes honestly', async () => {
    const port = await closedPort()
    const { engine, root } = await bootReal([
      'services:',
      '  - name: gamma',
      '    up: node exit.cjs gamma.pid',
      '    ready:',
      `      tcp: { port: ${port} }`,
      '    readyTimeoutMs: 8000',
      'test: echo t',
      '',
    ].join('\n'))

    const pending = engine.up()
    const pid = await pidIn(join(root, 'gamma.pid'))
    await waitFor(() => !alive(pid), 'the up process to exit')
    // The process is gone with exit code 0 and the probe has never passed;
    // readiness must still be reachable — the compose-style contract.
    const server = createTcpServer(() => {})
    await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => { resolve() }) })
    const report = await pending
    expect(report.ok).toBe(true)
    expect(engine.state).toBe('up')

    await expect(engine.status()).resolves.toEqual({
      state: 'up',
      services: [{ name: 'gamma', ready: true, probe: 'tcp', probeMs: aNumber() }],
    })
    await new Promise((resolve) => { server.close(resolve) })
    await expect(engine.status()).resolves.toEqual({
      state: 'up',
      services: [{ name: 'gamma', ready: false, probe: 'tcp', probeMs: aNumber() }],
    })
    await expect(engine.down()).resolves.toEqual({ ok: true, failures: [] })
  })

  it('resolves a service cwd against the workspace root and keeps logs readable after exit', async () => {
    const { engine, root } = await bootReal([
      'services:',
      '  - name: delta',
      '    up: node ../pwd.cjs',
      '    ready:',
      '      command: { run: "true" }',
      '    cwd: sub',
      'test: echo t',
      '',
    ].join('\n'))
    await mkdir(join(root, 'sub'))

    const report = await engine.up()
    expect(report.ok).toBe(true)
    await waitFor(() => engine.logs('delta').text.includes(join(root, 'sub')), 'the pwd output')
    await expect(engine.down()).resolves.toEqual({ ok: true, failures: [] })
  })
})

describe('startup failures over real processes', () => {
  it('fails fast on a non-zero exit before ready and rolls back in reverse with no survivors', async () => {
    const closed = await closedPort()
    const { engine, root } = await bootReal([
      'services:',
      '  - name: alpha',
      '    up: node idle.cjs alpha.pid alpha',
      '    ready:',
      // Readiness gated on the pid file, so alpha's pid is observable before
      // bravo can fail and trigger the rollback.
      '      command: { run: "test -f alpha.pid" }',
      '  - name: bravo',
      '    up: "echo boom-tail; exit 3"',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      '  - name: charlie',
      '    up: node idle.cjs charlie.pid charlie',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      'test: echo t',
      '',
    ].join('\n'))

    const alphaPidReady = pidIn(join(root, 'alpha.pid'))
    const report = await engine.up()
    expect(report.ok).toBe(false)
    expect(report.durationMs).toEqual(aNumber())
    expect(report.teardownFailures).toBeUndefined()
    expect(report.services.map(service => service.state)).toEqual(['ready', 'failed', 'not-started'])
    expect(report.services.map(service => service.probe)).toEqual(['command', 'tcp', 'tcp'])
    expect(report.services[0].readyAfterMs).toEqual(aNumber())
    const bravo = report.services[1]
    expect(bravo.detail).toContain('service "bravo" failed during startup')
    expect(bravo.detail).toContain('its process exited (exit code 3) before it became ready')
    expect(bravo.logTail).toContain('boom-tail')
    expect(engine.state).toBe('down')
    expect(alive(await alphaPidReady)).toBe(false)
    expect(await exists(join(root, 'charlie.pid'))).toBe(false)
  })

  it('fails on a readiness timeout while the process still runs, and terminates it', async () => {
    const closed = await closedPort()
    const { engine, root } = await bootReal([
      'services:',
      '  - name: echo-idle',
      '    up: node idle.cjs idle.pid echo-idle',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      '    readyTimeoutMs: 1000',
      'test: echo t',
      '',
    ].join('\n'))

    const pidReady = pidIn(join(root, 'idle.pid'))
    const report = await engine.up()
    expect(report.ok).toBe(false)
    expect(report.services[0].detail)
      .toContain('the service did not become ready within 1000ms; its process is still running and will be torn down')
    expect(engine.state).toBe('down')
    expect(alive(await pidReady)).toBe(false)
  })

  it('reports a clean early exit whose service never became ready at the deadline', async () => {
    const closed = await closedPort()
    const { engine } = await bootReal([
      'services:',
      '  - name: quitter',
      '    up: exit 0',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      '    readyTimeoutMs: 250',
      'test: echo t',
      '',
    ].join('\n'))

    const report = await engine.up()
    expect(report.ok).toBe(false)
    expect(report.services[0].detail)
      .toContain('its process exited (exit code 0) and the service never became ready within 250ms')
  })

  it('reports a signal-killed up process', async () => {
    const closed = await closedPort()
    const { engine } = await bootReal([
      'services:',
      '  - name: doomed',
      '    up: kill -KILL $$',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      'test: echo t',
      '',
    ].join('\n'))

    const report = await engine.up()
    expect(report.ok).toBe(false)
    const ending = process.platform === 'win32' ? 'exit code 2304' : 'killed by SIGKILL'
    expect(report.services[0].detail).toContain(`its process exited (${ending}) before it became ready`)
  })

  it('fails loud on a missing manifest and stays down', async () => {
    const { engine } = await bootReal(undefined)
    await expect(engine.up()).rejects.toThrow(ManifestError)
    await expect(engine.up()).rejects.toThrow('the manifest file cannot be read')
    expect(engine.state).toBe('down')
  })
})

describe('teardown over real processes', () => {
  it('degrades a down-command timeout to tree termination and reports it', async () => {
    const p1 = await listen(createTcpServer(() => {}))
    const { engine, root } = await bootReal([
      'services:',
      '  - name: slow',
      '    up: node idle.cjs slow.pid slow',
      '    ready:',
      `      tcp: { port: ${p1} }`,
      '    down: sleep 60',
      'test: echo t',
      '',
    ].join('\n'), { downTimeoutMs: 250, graceMs: 100 })

    await engine.up()
    const pid = await pidIn(join(root, 'slow.pid'))
    const down = await engine.down()
    expect(down.ok).toBe(false)
    expect(down.failures).toEqual([
      'service "slow": the down command timed out after 250ms; the process tree was terminated instead',
    ])
    expect(alive(pid)).toBe(false)
  })

  it('aggregates every teardown failure in reverse start order without giving up', async () => {
    const p1 = await listen(createTcpServer(() => {}))
    const { engine, root } = await bootReal([
      'services:',
      '  - name: one',
      '    up: node idle.cjs one.pid one',
      '    ready:',
      `      tcp: { port: ${p1} }`,
      '    down: "echo down-broke; exit 9"',
      '  - name: two',
      '    up: node idle.cjs two.pid two',
      '    ready:',
      `      tcp: { port: ${p1} }`,
      '    down: "false"',
      'test: echo t',
      '',
    ].join('\n'))

    await engine.up()
    const onePid = await pidIn(join(root, 'one.pid'))
    const twoPid = await pidIn(join(root, 'two.pid'))
    const down = await engine.down()
    expect(down.ok).toBe(false)
    expect(down.failures).toHaveLength(2)
    expect(down.failures[0]).toBe('service "two": the down command failed (exit code 1)')
    expect(down.failures[1]).toContain('service "one": the down command failed (exit code 9)')
    expect(down.failures[1]).toContain('down-broke')
    expect(alive(onePid)).toBe(false)
    expect(alive(twoPid)).toBe(false)
  })
})

describe('runTest over real processes', () => {
  const TRIVIAL_SERVICE = [
    'services:',
    '  - name: svc',
    '    up: echo svc-started',
    '    ready:',
    '      command: { run: "true" }',
  ]

  it('brings the environment up, seeds, runs the test, and reports a pass', async () => {
    const { engine } = await bootReal([
      ...TRIVIAL_SERVICE,
      'seed: echo seeded',
      'test: echo tested-ok',
      '',
    ].join('\n'))

    expect(engine.state).toBe('down')
    const report = await engine.runTest()
    expect(report.phase).toBe('test')
    expect(report.passed).toBe(true)
    expect(report).toMatchObject({ exitCode: 0 })
    expect(report).not.toHaveProperty('detail')
    if (report.phase === 'test') expect(report.outputTail).toContain('tested-ok')
    expect(engine.state).toBe('up')

    // A run that brought the environment up itself reports its own up timing,
    // the per-service startup facts, and each phase's duration.
    expect(report).toMatchObject({
      envReused: false,
      upDurationMs: aNumber(),
      seedDurationMs: aNumber(),
      testDurationMs: aNumber(),
      durationMs: aNumber(),
      services: [{ name: 'svc', state: 'ready', probe: 'command', readyAfterMs: aNumber() }],
    })
    expect(report).not.toHaveProperty('envUpAgeMs')

    // A re-run against the still-up environment reports reuse and its age instead.
    const again = await engine.runTest()
    expect(again).toMatchObject({ phase: 'test', passed: true, envReused: true, envUpAgeMs: aNumber() })
    expect(again).not.toHaveProperty('upDurationMs')
  })

  it('stops at a failing seed and names the phase', async () => {
    const { engine } = await bootReal([
      ...TRIVIAL_SERVICE,
      'seed: "echo seed-broke; exit 5"',
      'test: echo never-reached',
      '',
    ].join('\n'))

    const report = await engine.runTest()
    expect(report).toMatchObject({ phase: 'seed', passed: false, exitCode: 5, seedDurationMs: aNumber() })
    expect(report).not.toHaveProperty('testDurationMs')
    if (report.phase === 'seed') expect(report.outputTail).toContain('seed-broke')
  })

  it('reports a failing test command with its exit code and tail', async () => {
    const { engine } = await bootReal([
      ...TRIVIAL_SERVICE,
      'test: "echo test-broke; exit 7"',
      '',
    ].join('\n'))

    const report = await engine.runTest()
    expect(report).toMatchObject({ phase: 'test', passed: false, exitCode: 7 })
    if (report.phase === 'test') expect(report.outputTail).toContain('test-broke')
  })

  it('terminates a test overrunning its deadline and says so', async () => {
    const { engine } = await bootReal([
      ...TRIVIAL_SERVICE,
      'test: sleep 60',
      '',
    ].join('\n'), { testTimeoutMs: 300, graceMs: 100 })

    const report = await engine.runTest()
    expect(report).toMatchObject({
      phase: 'test',
      passed: false,
      exitCode: null,
      detail: 'the test command timed out after 300ms and was terminated',
    })
  })

  it('returns the up failure when the environment cannot start', async () => {
    const closed = await closedPort()
    const { engine } = await bootReal([
      'services:',
      '  - name: broken',
      '    up: exit 3',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      'test: echo never',
      '',
    ].join('\n'))

    const report = await engine.runTest()
    expect(report.phase).toBe('up')
    expect(report.passed).toBe(false)
    expect(report).toMatchObject({ envReused: false, durationMs: aNumber() })
    if (report.phase === 'up') {
      expect(report.up.ok).toBe(false)
      expect(report.up.services[0].state).toBe('failed')
    }
    expect(engine.state).toBe('down')
  })
})

describe('runTestObserved over real processes', () => {
  const TRIVIAL_SERVICE = [
    'services:',
    '  - name: svc',
    '    up: echo svc-started',
    '    ready:',
    '      command: { run: "true" }',
  ]

  /** Poll a handle's consuming cursor into an accumulator until it contains `needle`. */
  async function readUntil(handle: { readOutput(): string }, state: { text: string }, needle: string): Promise<void> {
    await waitFor(() => {
      state.text += handle.readOutput()
      return state.text.includes(needle)
    }, `observed output containing ${JSON.stringify(needle)}`)
  }

  it('streams phase markers and live test output, then settles with the runTest report', async () => {
    const { engine, root } = await bootReal([
      ...TRIVIAL_SERVICE,
      'seed: echo seeded',
      'test: "echo test-line-one; while [ ! -f go ]; do sleep 0.05; done; printf trailing-chunk"',
      '',
    ].join('\n'))

    const handle = engine.runTestObserved()
    const seen = { text: '' }
    // The test output is readable while the test process still runs: nothing
    // has created the go file yet, so the command cannot have exited.
    await readUntil(handle, seen, 'test-line-one')
    expect(seen.text).toContain('[up] starting service "svc" (1/1)')
    expect(seen.text).toContain('[up] service "svc" is ready')
    expect(seen.text).toContain('[up] every service is ready')
    expect(seen.text).toContain('[seed] running: echo seeded')
    expect(seen.text).toContain('[seed] done (exit code 0)')
    expect(seen.text).toContain('[test] running:')
    await writeFile(join(root, 'go'), '')

    const report = await handle.done
    expect(report).toMatchObject({ phase: 'test', passed: true, exitCode: 0, envReused: false })
    if (report.phase === 'test') expect(report.outputTail).toContain('trailing-chunk')
    seen.text += handle.readOutput()
    // The trailing chunk carries no newline; the settling marker still starts its own line.
    expect(seen.text).toContain('trailing-chunk\n[test] settled (exit code 0)')
    expect(handle.readOutput()).toBe('')
    expect(engine.state).toBe('up')
  })

  it('marks reuse, and a failing seed, on an already-up environment', async () => {
    const { engine } = await bootReal([
      ...TRIVIAL_SERVICE,
      'seed: "echo seed-broke; exit 5"',
      'test: echo never-reached',
      '',
    ].join('\n'))
    await engine.up()

    const handle = engine.runTestObserved()
    const report = await handle.done
    expect(report).toMatchObject({ phase: 'seed', passed: false, exitCode: 5, envReused: true })
    const text = handle.readOutput()
    expect(text).toContain('[up] reusing the environment an earlier call brought up')
    expect(text).toContain('seed-broke')
    expect(text).toContain('[seed] failed (exit code 5)')
    expect(text).not.toContain('[test]')
    expect(engine.state).toBe('up')
  })

  it('cancel terminates the test tree and tears down the environment this run brought up', async () => {
    const { engine, root } = await bootReal([
      'services:',
      '  - name: alpha',
      '    up: node idle.cjs alpha.pid alpha',
      '    ready:',
      '      command: { run: "test -f alpha.pid" }',
      'test: node idle.cjs test.pid test-child',
      '',
    ].join('\n'), { graceMs: 100 })

    const handle = engine.runTestObserved()
    const testPid = await pidIn(join(root, 'test.pid'))
    const alphaPid = await pidIn(join(root, 'alpha.pid'))
    handle.cancel()
    handle.cancel()

    const report = await handle.done
    expect(report).toMatchObject({
      phase: 'test',
      passed: false,
      detail: 'the test command was cancelled and its process tree was terminated',
    })
    expect(engine.state).toBe('down')
    await waitFor(() => !alive(testPid), 'the cancelled test process to exit')
    await waitFor(() => !alive(alphaPid), 'the torn-down service process to exit')
    expect(handle.readOutput()).toContain('[cancelled] tearing the environment down')
  })

  it('cancel leaves a reused environment up, because the earlier up() owns it', async () => {
    const { engine, root } = await bootReal([
      'services:',
      '  - name: alpha',
      '    up: node idle.cjs alpha.pid alpha',
      '    ready:',
      '      command: { run: "test -f alpha.pid" }',
      'test: sleep 60',
      '',
    ].join('\n'), { graceMs: 100 })
    await engine.up()
    const alphaPid = await pidIn(join(root, 'alpha.pid'))

    const handle = engine.runTestObserved()
    await waitFor(() => handle.readOutput().includes('[test] running:'), 'the test phase to start')
    handle.cancel()
    const report = await handle.done
    expect(report).toMatchObject({ phase: 'test', passed: false })
    expect(engine.state).toBe('up')
    expect(alive(alphaPid)).toBe(true)
    await engine.down()
    await waitFor(() => !alive(alphaPid), 'the service process to exit after env_down')
  })

  it('cancel during the up phase rolls the started services back with the cancellation named', async () => {
    const closed = await closedPort()
    const { engine, root } = await bootReal([
      'services:',
      '  - name: alpha',
      '    up: node idle.cjs alpha.pid alpha',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      'test: echo never',
      '',
    ].join('\n'), { graceMs: 100 })

    const handle = engine.runTestObserved()
    const alphaPid = await pidIn(join(root, 'alpha.pid'))
    handle.cancel()
    const report = await handle.done
    expect(report.phase).toBe('up')
    if (report.phase === 'up') {
      expect(report.up.services[0]).toMatchObject({
        state: 'failed',
        detail: 'service "alpha" failed during startup: the run was cancelled before the service became ready',
      })
    }
    expect(engine.state).toBe('down')
    await waitFor(() => !alive(alphaPid), 'the rolled-back service process to exit')
    const text = handle.readOutput()
    expect(text).toContain('[up] the environment failed to start; every started service was rolled back')
    expect(text).not.toContain('[cancelled]')
  })

  it('announces a lossy read when the test output overruns the in-memory tail', async () => {
    const { engine } = await bootReal([
      ...TRIVIAL_SERVICE,
      'test: "head -c 4096 /dev/zero | tr \'\\\\0\' x; echo; echo lossy-tail-end"',
      '',
    ].join('\n'), { logTailBytes: 256 })

    const handle = engine.runTestObserved()
    const report = await handle.done
    expect(report).toMatchObject({ phase: 'test', passed: true })
    const text = handle.readOutput()
    expect(text).toContain('(the in-memory tail overflowed; earlier output was dropped)')
    expect(text).toContain('lossy-tail-end')
  })
})

describe('fiber disposal', () => {
  it('disposing the owning fiber tears the environment down', async () => {
    const p1 = await listen(createTcpServer(() => {}))
    const root = await mkdtemp(join(tmpdir(), 'testenv-engine-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'idle.cjs'), IDLE_SCRIPT)
    await writeFile(join(root, 'testenv.yml'), [
      'services:',
      '  - name: alpha',
      '    up: node idle.cjs alpha.pid alpha',
      '    ready:',
      `      tcp: { port: ${p1} }`,
      'test: echo t',
      '',
    ].join('\n'))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)

    let engine: TestenvEngine | undefined
    const fiber = await ctx.plugin({
      inject: ['subprocess'],
      apply: (child: Context) => {
        engine = new TestenvEngine(child, settings(root))
      },
    })
    const report = await engine!.up()
    expect(report.ok).toBe(true)
    const pid = await pidIn(join(root, 'alpha.pid'))
    expect(alive(pid)).toBe(true)

    await fiber.dispose()
    expect(alive(pid)).toBe(false)
    expect(engine!.state).toBe('down')
    await expect(engine!.status()).resolves.toEqual({ state: 'down', services: [] })
  })
})

/** Offset-based reader over a fixed captured text. */
function fakeReader(text: string): SubprocessOutputReader {
  return { readFrom: fromByte => ({ text: text.slice(fromByte), nextOffset: text.length, lossy: false }) }
}

interface FakeHandleOptions {
  /** Exit facts, a scripted rejection, or omitted for a process that never exits. */
  outcome?: SubprocessOutcome | Promise<SubprocessOutcome>
  stdoutText?: string
  stderrText?: string
  /** What `waitForExit` answers; false scripts a tree that refuses to die. */
  treeExits?: boolean
  /** False scripts a handle that captured nothing. */
  collect?: boolean
}

class FakeHandle implements SubprocessHandle {
  readonly pid = 4242
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  terminated = 0
  private readonly exits: boolean

  constructor(options: FakeHandleOptions = {}) {
    this.exits = options.treeExits ?? true
    this.done = Promise.resolve(options.outcome ?? new Promise<SubprocessOutcome>(() => {}))
    this.done.catch(() => {
      // Keeps a scripted rejection from surfacing as an unhandled rejection
      // before the engine attaches its own handlers.
    })
    this.collected = options.collect === false ? {} : {
      stdout: fakeReader(options.stdoutText ?? ''),
      ...options.stderrText === undefined ? {} : { stderr: fakeReader(options.stderrText) },
    }
  }

  terminate(): void {
    this.terminated += 1
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(this.exits)
  }
}

class FakeSubprocess implements SubprocessSpawner {
  readonly log: string[] = []
  private readonly rules: { match: string; create: (spec: SubprocessSpawnSpec) => FakeHandle }[] = []

  on(match: string, create: (spec: SubprocessSpawnSpec) => FakeHandle): void {
    this.rules.push({ match, create })
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const script = spec.argv.join(' ')
    const rule = this.rules.find(entry => script.includes(entry.match))
    if (rule === undefined) throw new Error(`no scripted behavior for: ${script}`)
    this.log.push(rule.match)
    return rule.create(spec)
  }
}

function fakeHost(spawner: FakeSubprocess): EngineHost {
  return {
    subprocess: spawner,
    effect: (execute) => {
      const disposer = execute()
      return () => disposer()
    },
  }
}

async function bootFake(manifest: string, fake: FakeSubprocess): Promise<TestenvEngine> {
  const root = await mkdtemp(join(tmpdir(), 'testenv-engine-fake-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'testenv.yml'), manifest)
  return new TestenvEngine(fakeHost(fake), settings(root, { readyPollIntervalMs: 5 }))
}

const TWO_SERVICE_MANIFEST = [
  'services:',
  '  - name: one',
  '    up: up-one',
  '    ready:',
  '      command: { run: probe-one }',
  '  - name: two',
  '    up: up-two',
  '    ready:',
  '      command: { run: probe-two }',
  'test: noop',
  '',
].join('\n')

function exitHandle(code: number): FakeHandle {
  return new FakeHandle({ outcome: { exitCode: code, signal: null } })
}

describe('state machine over a scripted subprocess double', () => {
  it('settles an abort rejection as cancellation after the platform runner has accepted the spawn', async () => {
    const fake = new FakeSubprocess()
    const up = new FakeHandle()
    fake.on('up-one', () => up)
    fake.on('probe-one', () => exitHandle(0))
    fake.on('test-one', spec => new FakeHandle({
      outcome: new Promise<SubprocessOutcome>((_resolve, reject) => {
        spec.signal?.addEventListener('abort', () => { reject(new Error('runner start was cancelled')) }, { once: true })
      }),
    }))
    const engine = await bootFake([
      'services:',
      '  - name: one',
      '    up: up-one',
      '    ready:',
      '      command: { run: probe-one }',
      'test: test-one',
      '',
    ].join('\n'), fake)
    await engine.up()

    const handle = engine.runTestObserved()
    await waitFor(() => fake.log.includes('test-one'), 'the observed test spawn')
    handle.cancel()

    await expect(handle.done).resolves.toMatchObject({
      phase: 'test',
      passed: false,
      exitCode: null,
      detail: 'the test command was cancelled and its process tree was terminated',
    })
    expect(engine.state).toBe('up')
    await engine.down()
  })

  it('starts strictly in declaration order and rejects up/down while starting', async () => {
    const fake = new FakeSubprocess()
    const oneUp = new FakeHandle()
    const twoUp = new FakeHandle()
    let oneReady = false
    let twoReady = false
    fake.on('up-one', () => oneUp)
    fake.on('probe-one', () => exitHandle(oneReady ? 0 : 1))
    fake.on('up-two', () => twoUp)
    fake.on('probe-two', () => exitHandle(twoReady ? 0 : 1))
    const engine = await bootFake(TWO_SERVICE_MANIFEST, fake)

    const pending = engine.up()
    await waitFor(() => fake.log.includes('up-one'), 'the first service spawn')
    expect(fake.log).not.toContain('up-two')
    expect(engine.state).toBe('starting')
    await expect(engine.up()).rejects.toThrow('the environment is starting; bring it down before starting it again')
    await expect(engine.down()).rejects.toThrow('the environment is starting; wait for that transition to settle')

    oneReady = true
    await waitFor(() => fake.log.includes('up-two'), 'the second service spawn')
    expect(fake.log.indexOf('up-two')).toBeGreaterThan(fake.log.lastIndexOf('up-one'))
    twoReady = true
    const report = await pending
    expect(report.ok).toBe(true)
    expect(engine.state).toBe('up')

    await expect(engine.down()).resolves.toEqual({ ok: true, failures: [] })
    expect(oneUp.terminated).toBeGreaterThan(0)
    expect(twoUp.terminated).toBeGreaterThan(0)
    expect(engine.state).toBe('down')
  })

  it('reports a spawn-level up failure and surfaces a rollback that leaves residue', async () => {
    const fake = new FakeSubprocess()
    const oneUp = new FakeHandle({ treeExits: false, stdoutText: 'one-tail\n' })
    const twoUp = new FakeHandle({ outcome: Promise.reject(new Error('spawn ENOENT sh')), collect: false })
    fake.on('up-one', () => oneUp)
    fake.on('probe-one', () => exitHandle(0))
    fake.on('up-two', () => twoUp)
    fake.on('probe-two', () => exitHandle(1))
    const engine = await bootFake(TWO_SERVICE_MANIFEST, fake)

    const report = await engine.up()
    expect(report.ok).toBe(false)
    expect(report.services.map(service => service.state)).toEqual(['ready', 'failed'])
    const failed = report.services[1]
    expect(failed.detail).toContain('service "two" failed during startup: its up command could not be spawned: spawn ENOENT sh')
    expect(failed.logTail).toBe('')
    expect(report.teardownFailures).toEqual([
      'service "one": the up process tree did not exit within 5000ms of termination',
    ])
    expect(oneUp.terminated).toBeGreaterThan(0)
    expect(twoUp.terminated).toBeGreaterThan(0)
    expect(engine.state).toBe('down')
  })

  it('converts a probe defect into a service failure carrying both output streams', async () => {
    const fake = new FakeSubprocess()
    fake.on('up-one', () => new FakeHandle({ stdoutText: 'out-tail\n', stderrText: 'err-tail\n' }))
    fake.on('probe-one', () => new FakeHandle({ outcome: Promise.reject(new Error('probe blew up')), collect: false }))
    const engine = await bootFake([
      'services:',
      '  - name: one',
      '    up: up-one',
      '    ready:',
      '      command: { run: probe-one }',
      'test: noop',
      '',
    ].join('\n'), fake)

    const report = await engine.up()
    expect(report.ok).toBe(false)
    const failed = report.services[0]
    expect(failed.detail).toBe('service "one" failed during startup: its readiness probe failed: probe blew up')
    expect(failed.logTail).toBe('out-tail\n--- stderr ---\nerr-tail\n')
    expect(report.teardownFailures).toBeUndefined()
    expect(engine.state).toBe('down')
  })

  it('reports a down command that cannot be spawned and still terminates the tree', async () => {
    const fake = new FakeSubprocess()
    const oneUp = new FakeHandle()
    fake.on('up-one', () => oneUp)
    fake.on('probe-one', () => exitHandle(0))
    fake.on('down-one', () => new FakeHandle({ outcome: Promise.reject(new Error('EACCES boom')), collect: false }))
    const engine = await bootFake([
      'services:',
      '  - name: one',
      '    up: up-one',
      '    ready:',
      '      command: { run: probe-one }',
      '    down: down-one',
      'test: noop',
      '',
    ].join('\n'), fake)

    await engine.up()
    const down = await engine.down()
    expect(down.ok).toBe(false)
    expect(down.failures).toEqual([
      'service "one": the down command could not be spawned (EACCES boom); the process tree was terminated instead',
    ])
    expect(oneUp.terminated).toBeGreaterThan(0)
  })
})
