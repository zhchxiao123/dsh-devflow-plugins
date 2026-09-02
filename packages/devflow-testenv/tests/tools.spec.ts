/**
 * The five model-facing tools over a real tool registry and real child
 * processes: registration and fiber-disposal removal, each tool's success and
 * failure renders, the manifest-defect pointer at the bootstrap skill, the
 * presentCall annotations, and the render branches only a crafted value can
 * reach (render is pure, so those are driven directly).
 */
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { TestenvEngine } from '../src/engine.ts'
import { registerTools } from '../src/tools.ts'
import type { EngineSettings } from '../src/types.ts'

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
}

async function bootTools(manifest: string | undefined, overrides: Partial<EngineSettings> = {}): Promise<ToolsEnv> {
  const root = await mkdtemp(join(tmpdir(), 'testenv-tools-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  if (manifest !== undefined) await writeFile(join(root, 'testenv.yml'), manifest)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin({
    inject: ['tools', 'subprocess'],
    apply: (child: Context) => {
      registerTools(child, new TestenvEngine(child, settings(root, overrides)))
    },
  })
  return { ctx, root, fiber }
}

async function call(ctx: Context, name: string, args: object = {}): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `testenv-${name}-${Math.random()}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
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
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)

    const up = await call(ctx, 'env_up')
    expect(up.isError).toBeFalsy()
    expect(up.text).toMatch(new RegExp(
      `^Environment is up in ${D}; every service is ready\\.\\n\\[ready\\] svc \\(command probe, ready in ${D}\\)$`,
    ))

    const status = await call(ctx, 'env_status')
    expect(status.isError).toBeFalsy()
    expect(status.text).toMatch(new RegExp(
      `^Environment is up; every readiness probe passed just now\\.\\n\\[ready\\] svc \\(command probe, answered in ${D}\\)$`,
    ))

    await waitFor(async () => (await call(ctx, 'env_logs', { service: 'svc' })).text.includes('hello-from-svc'), 'the service output')
    const logs = await call(ctx, 'env_logs', { service: 'svc' })
    expect(logs.isError).toBeFalsy()
    const offset = Number(/\(next offset: (\d+)\)/.exec(logs.text)?.[1])
    expect(offset).toBeGreaterThan(0)
    const delta = await call(ctx, 'env_logs', { service: 'svc', fromOffset: offset })
    expect(delta.text).toBe(`(no new output)\n(next offset: ${offset})`)

    const down = await call(ctx, 'env_down')
    expect(down.isError).toBeFalsy()
    expect(down.text).toBe('Environment is down; no service left residue.')
    const again = await call(ctx, 'env_down')
    expect(again.text).toBe('Environment is down; no service left residue.')
    const idle = await call(ctx, 'env_status')
    expect(idle.text).toBe('The environment is not up; env_up starts it.')
  })

  it('reports a failed startup with the service, the exit facts, and the log tail', async () => {
    const closed = await closedPort()
    const { ctx } = await bootTools([
      'services:',
      '  - name: bravo',
      '    up: "echo boom-tail; exit 3"',
      '    ready:',
      `      tcp: { port: ${closed} }`,
      'test: echo t',
      '',
    ].join('\n'))

    const up = await call(ctx, 'env_up')
    expect(up.isError).toBeFalsy()
    expect(up.text).toMatch(new RegExp(`Environment failed to start in ${D}; every started service was torn back down\\.`))
    expect(up.text).toContain('[failed] bravo')
    expect(up.text).toContain('its process exited (exit code 3) before it became ready')
    expect(up.text).toContain('  log tail:')
    expect(up.text).toContain('    boom-tail')
  })

  it('propagates a non-manifest engine rejection verbatim', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    await call(ctx, 'env_up')
    const second = await call(ctx, 'env_up')
    expect(second.isError).toBe(true)
    expect(second.text).toContain('the environment is up; bring it down before starting it again')
  })

  it('re-probes on env_status and names the decayed service', async () => {
    const { ctx, root } = await bootTools([
      'services:',
      '  - name: decaying',
      '    up: echo started',
      '    ready:',
      '      command: { run: "test -f ready-flag" }',
      'test: echo t',
      '',
    ].join('\n'))
    await writeFile(join(root, 'ready-flag'), '')

    const up = await call(ctx, 'env_up')
    expect(up.isError).toBeFalsy()
    await unlink(join(root, 'ready-flag'))
    const status = await call(ctx, 'env_status')
    expect(status.isError).toBeFalsy()
    expect(status.text).toMatch(new RegExp([
      '^Environment is up, but not every readiness probe passed just now\\.',
      `\\[failed\\] decaying \\(command probe, answered in ${D}\\)`,
      '  its readiness probe did not pass when re-checked$',
    ].join('\\n')))
  })

  it('rejects unknown services, down-state reads, and negative offsets on env_logs', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)
    const downState = await call(ctx, 'env_logs', { service: 'svc' })
    expect(downState.isError).toBe(true)
    expect(downState.text).toContain('the environment is down; logs are only readable while it is up')

    await call(ctx, 'env_up')
    const unknown = await call(ctx, 'env_logs', { service: 'nope' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('unknown service "nope"; the manifest declares: svc')

    const negative = await call(ctx, 'env_logs', { service: 'svc', fromOffset: -1 })
    expect(negative.isError).toBe(true)
    expect(negative.text).toContain('fromOffset must be a non-negative byte offset, got -1')
  })

  it('folds a failed rollback\'s residue into env_up teardownDetail', async () => {
    const closed = await closedPort()
    const { ctx } = await bootTools([
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

    const up = await call(ctx, 'env_up')
    expect(up.isError).toBeFalsy()
    expect(up.text).toMatch(new RegExp(`Environment failed to start in ${D}, and rolling the started services back left residue\\.`))
    expect(up.text).toContain('[ready] messy')
    expect(up.text).toContain('[failed] broken')
    expect(up.text).toContain('Rollback residue:')
    expect(up.text).toContain('  service "messy": the down command failed (exit code 1)')
  })

  it('folds teardown residue into env_down detail', async () => {
    const { ctx } = await bootTools([
      'services:',
      '  - name: messy',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      '    down: "false"',
      'test: echo t',
      '',
    ].join('\n'))

    await call(ctx, 'env_up')
    const down = await call(ctx, 'env_down')
    expect(down.isError).toBeFalsy()
    expect(down.text).toBe([
      'Environment is down, with teardown residue:',
      'service "messy": the down command failed (exit code 1)',
    ].join('\n'))
  })
})

describe('manifest defects point at the bootstrap skill', () => {
  it('surfaces a missing manifest with its path and the repair pointer', async () => {
    const { ctx, root } = await bootTools(undefined)
    const up = await call(ctx, 'env_up')
    expect(up.isError).toBe(true)
    expect(up.text).toContain(`testenv manifest ${join(root, 'testenv.yml')} is invalid`)
    expect(up.text).toContain('the manifest file cannot be read')
    expect(up.text).toContain('Run the `testenv-bootstrap` skill')
  })

  it('keeps every field-path issue verbatim ahead of the pointer', async () => {
    const { ctx } = await bootTools([
      'services:',
      '  - name: preview',
      '    kind: static',
      '    up: serve dist',
      '    ready:',
      '      command: { run: "true" }',
      '',
    ].join('\n'))

    const report = await call(ctx, 'integration_test')
    expect(report.isError).toBe(true)
    expect(report.text).toContain("services[0].kind: 'static' services are reserved for future static preview hosting")
    expect(report.text).toContain('test must be a non-empty string')
    expect(report.text).toContain('Run the `testenv-bootstrap` skill to research how this project\'s services start and to write or repair testenv.yml.')
  })
})

describe('integration_test over real services', () => {
  it('reports a pass with the exit code and output tail, leaving the environment up', async () => {
    const { ctx } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'seed: echo seeded',
      'test: echo tested-ok',
      '',
    ].join('\n'))

    const report = await call(ctx, 'integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`^Integration test passed \\(exit code 0\\) in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(`Environment: started by this run in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(`\\[ready\\] svc \\(command probe, ready in ${D}\\)`))
    expect(report.text).toMatch(new RegExp(`Phases:\\n {2}✓ up ${D}\\n {2}✓ seed ${D}\\n {2}✓ test ${D}`))
    expect(report.text).toContain('--- output tail ---')
    expect(report.text).toContain('tested-ok')
    const status = await call(ctx, 'env_status')
    expect(status.text).toContain('Environment is up')
  })

  it('names a failing seed phase with its exit code and tail', async () => {
    const { ctx } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'seed: "echo seed-broke; exit 5"',
      'test: echo never-reached',
      '',
    ].join('\n'))

    const report = await call(ctx, 'integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`Integration test failed during the seed phase \\(exit code 5\\) in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(` {2}✗ seed ${D}`))
    expect(report.text).not.toMatch(/[✓✗] test /)
    expect(report.text).toContain('seed-broke')
    expect(report.text).not.toContain('never-reached')
  })

  it('reports a deadline-cut test with the timeout detail and no exit code', async () => {
    const { ctx } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'test: sleep 60',
      '',
    ].join('\n'), { testTimeoutMs: 300, graceMs: 100 })

    const report = await call(ctx, 'integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`Integration test failed during the test phase in ${D}\\.`))
    expect(report.text).toContain('the test command timed out after 300ms and was terminated')
    expect(report.text).not.toContain('(exit code')
  })

  it('reports a failed up phase with the per-service startup state', async () => {
    const closed = await closedPort()
    const { ctx } = await bootTools([
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

    const report = await call(ctx, 'integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`Integration test failed in ${D}: the environment did not start\\.`))
    expect(report.text).toContain('[failed] broken (tcp probe)')
    expect(report.text).toContain('[not-started] waiting (command probe)')
  })

  it('leads a failing test with the phase and duration, and puts the runner summary ahead of the tail', async () => {
    const { ctx } = await bootTools([
      'services:',
      '  - name: svc',
      '    up: echo started',
      '    ready:',
      '      command: { run: "true" }',
      'test: "echo scenario-noise; echo \'==================== 2 failed, 3 passed in 0.12s ====================\'; exit 1"',
      '',
    ].join('\n'))

    const report = await call(ctx, 'integration_test')
    expect(report.isError).toBeFalsy()
    expect(report.text).toMatch(new RegExp(`^Integration test failed during the test phase \\(exit code 1\\) in ${D}\\.`))
    expect(report.text).toMatch(new RegExp(`\\[ready\\] svc \\(command probe, ready in ${D}\\)`))
    expect(report.text).toMatch(new RegExp(` {2}✗ test ${D}`))
    expect(report.text).toContain('Runner summary: ==================== 2 failed, 3 passed in 0.12s ====================')
    expect(report.text.indexOf('Runner summary:')).toBeLessThan(report.text.indexOf('--- output tail ---'))
  })

  it('marks the environment as started by a fresh run and as reused on a re-run', async () => {
    const { ctx } = await bootTools(ECHO_SERVICE_MANIFEST)

    const first = await call(ctx, 'integration_test')
    expect(first.text).toMatch(new RegExp(`Environment: started by this run in ${D}\\.`))
    expect(first.text).toMatch(new RegExp(` {2}✓ up ${D}`))

    const second = await call(ctx, 'integration_test')
    expect(second.text).toMatch(new RegExp(`Environment: reused \\(up ${D} ago\\)\\.`))
    expect(second.text).not.toMatch(/[✓✗] up /)
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
    await ctx.plugin({
      inject: ['tools'],
      apply: (child: Context) => { registerTools(child, engine) },
    })

    expect((await call(ctx, 'env_up')).text).toBe('Environment is up; every service is ready.\n[ready] svc')
    expect((await call(ctx, 'env_status')).text).toBe('Environment is up; every readiness probe passed just now.\n[ready] svc')
    expect((await call(ctx, 'integration_test')).text).toBe('Integration test passed (exit code 0).')
  })
})
