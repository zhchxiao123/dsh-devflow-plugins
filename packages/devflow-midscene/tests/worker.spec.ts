import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkerInput } from '../src/types.ts'
const fixture = vi.hoisted(() => ({
  launch: vi.fn(),
  connect: vi.fn(),
  serverClose: vi.fn(),
  contextClose: vi.fn(),
  probe: vi.fn(),
  newContext: vi.fn(),
  goto: vi.fn(),
  screenshot: vi.fn(),
  text: vi.fn(),
  act: vi.fn(),
  assert: vi.fn(),
  destroy: vi.fn(),
  agentCreated: vi.fn(),
  report: '' as string | undefined,
  terminate: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('playwright', () => ({ chromium: { launchServer: fixture.launch, connect: fixture.connect } }))
vi.mock('@midscene/web/playwright', () => ({
  PlaywrightAgent: class {
    constructor(_page: unknown, options: unknown) {
      fixture.agentCreated(options)
    }
    get reportFile() {
      return fixture.report
    }
    aiAct = fixture.act
    aiAssert = fixture.assert
    destroy = fixture.destroy
  },
}))
vi.mock('../src/process-tree.ts', () => ({ terminateOwnedTree: fixture.terminate }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: fixture.spawn,
}))
import { runWorker as executeWorker, workerMain as startWorker } from '../src/worker.ts'
import type { WorkerHost } from '../src/worker.ts'
let input: WorkerInput
let dir: string
let events: unknown[]
let lifecycle: EventEmitter
let host: WorkerHost
const runWorker = (input: WorkerInput, send: (event: unknown) => void) => executeWorker(input, send, lifecycle)
const workerMain = (args: string[]) => startWorker(args, host)
let page: {
  goto: typeof fixture.goto
  screenshot: typeof fixture.screenshot
  locator: () => { innerText: typeof fixture.text }
}
type RouteHandler = (route: {
  request: () => { url: () => string; isNavigationRequest: () => boolean }
  abort: () => Promise<void>
  continue: () => Promise<void>
}) => Promise<void>
function routeMock() {
  return vi.fn<(_pattern: string, handler: RouteHandler) => Promise<void>>().mockResolvedValue(undefined)
}
let context: {
  close: typeof fixture.contextClose
  newPage: () => Promise<typeof page>
  route: ReturnType<typeof routeMock>
}
beforeEach(async () => {
  vi.resetAllMocks()
  lifecycle = new EventEmitter()
  dir = await mkdtemp(join(tmpdir(), 'midscene-worker-'))
  input = {
    runDir: dir,
    maxSteps: 10,
    cleanupTimeoutMs: 1,
    suite: {
      version: 1,
      name: 'transport',
      baseUrl: 'http://fixture.invalid',
      buildProbe: { path: '/build', expected: 'build' },
      cases: [
        {
          id: 'case',
          steps: [
            { kind: 'goto', path: '/' },
            { kind: 'act', prompt: 'Action' },
            { kind: 'text', selector: 'h1', expected: 'Heading' },
            { kind: 'assert', prompt: 'Visible' },
          ],
        },
      ],
    },
  }
  events = []
  fixture.report = join(dir, 'raw.html')
  await writeFile(fixture.report, '<html>fixture-token-secret</html>')
  await mkdir(join(dir, 'subdirectory'))
  await writeFile(join(dir, 'binary.bin'), 'unrelated')
  fixture.serverClose.mockResolvedValue(undefined)
  fixture.contextClose.mockResolvedValue(undefined)
  fixture.launch.mockResolvedValue({
    close: fixture.serverClose,
    wsEndpoint: () => 'ws://fixture',
    process: () => ({ pid: 12345 }),
  })
  fixture.probe.mockResolvedValue({
    ok: () => true,
    url: () => 'http://fixture.invalid/build',
    text: async () => 'build',
  })
  fixture.goto.mockResolvedValue(undefined)
  fixture.act.mockResolvedValue(undefined)
  fixture.assert.mockResolvedValue(undefined)
  fixture.destroy.mockResolvedValue(undefined)
  fixture.text.mockResolvedValue('Heading')
  fixture.screenshot.mockImplementation(async ({ path }: { path: string }) => {
    await writeFile(path, 'png')
  })
  page = { goto: fixture.goto, screenshot: fixture.screenshot, locator: () => ({ innerText: fixture.text }) }
  context = { close: fixture.contextClose, newPage: async () => page, route: routeMock() }
  fixture.newContext
    .mockReset()
    .mockResolvedValueOnce({ request: { get: fixture.probe }, close: vi.fn() })
    .mockResolvedValue(context)
  fixture.connect.mockResolvedValue({ newContext: fixture.newContext })
  fixture.spawn.mockReturnValue({ unref: vi.fn() })
  fixture.terminate.mockResolvedValue(undefined)
  host = Object.assign(lifecycle, { cwd: () => dir, connected: false, disconnect: vi.fn() })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})
function emit(event: unknown): void {
  events.push(event)
}
function stop(event: string, value?: unknown): void {
  if (lifecycle.listenerCount(event) === 0) throw new Error('Missing listener')
  lifecycle.emit(event, value)
}
function result(): unknown {
  return events.find(e => e && typeof e === 'object' && 'type' in e && e.type === 'case-complete')
}

it('publishes finite progress, usage, artifacts and disposes lifecycle listeners', async () => {
  vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'fixture-token-secret')
  input.executablePath = '/test/chromium'
  fixture.agentCreated.mockImplementation((options: { onLLMUsage: (usage: object) => void }) => {
    for (const listener of lifecycle.listeners('message'))
      expect(process.listeners('message')).not.toContain(listener)
    options.onLLMUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
    options.onLLMUsage({})
  })
  context.route.mockImplementation(
    async (
      _pattern: string,
      handler: (route: {
        request: () => { url: () => string; isNavigationRequest: () => boolean }
        abort: () => Promise<void>
        continue: () => Promise<void>
      }) => Promise<void>,
    ) => {
      const abort = vi.fn().mockResolvedValue(undefined)
      const proceed = vi.fn().mockResolvedValue(undefined)
      for (const [url, navigation] of [
        ['https://foreign.invalid', true],
        ['http://fixture.invalid', true],
        ['https://foreign.invalid', false],
      ] as const)
        await handler({
          request: () => ({ url: () => url, isNavigationRequest: () => navigation }),
          abort,
          continue: proceed,
        })
      expect(abort).toHaveBeenCalledOnce()
      expect(proceed).toHaveBeenCalledTimes(2)
    },
  )
  await runWorker(input, emit)
  expect(result()).toMatchObject({ result: { status: 'passed', completedSteps: 4, passedAssertions: 2 } })
  expect(events).toContainEqual({ type: 'usage', promptTokens: null, completionTokens: null, totalTokens: null })
  expect(await readFile(join(dir, 'case-0.html'), 'utf8')).not.toContain('fixture-token-secret')
  expect(events.at(-1)).toEqual({ type: 'finished', cleanup: 'confirmed' })
  expect(lifecycle.eventNames()).toEqual([])
})
it.each([
  new Error('Assertion failed: false'),
  new Error('Assertion failed: upstream', { cause: new Error('Transport') }),
  new Error('Unexpected SDK error'),
  'not-an-error',
])('keeps SDK assertion failures separate from transport errors: %s', async (error) => {
  fixture.assert.mockRejectedValue(error)
  await runWorker(input, emit)
  expect(result()).toMatchObject({
    result: {
      status:
        error instanceof Error && error.message === 'Assertion failed: false'
          ? 'assertion-failed'
          : 'infrastructure-error',
    },
  })
})
it.each(['text', 'screenshot', 'destroy', 'context', 'server', 'report'] as const)(
  'records failure without fabricating resource or evidence success: %s',
  async (failure) => {
    if (failure === 'text') fixture.text.mockResolvedValue('wrong')
    if (failure === 'screenshot') fixture.screenshot.mockRejectedValue(new Error('Disconnected'))
    if (failure === 'destroy') fixture.destroy.mockRejectedValue(new Error('Write failed'))
    if (failure === 'context') fixture.contextClose.mockRejectedValue(new Error('Close failed'))
    if (failure === 'server') fixture.serverClose.mockRejectedValue(new Error('Close failed'))
    if (failure === 'report') fixture.report = undefined
    await runWorker(input, emit)
    expect(events.at(-1)).toMatchObject({
      cleanup: failure === 'server' || failure === 'context' ? 'unknown' : 'confirmed',
    })
    expect(result()).toBeDefined()
  },
)
it.each(['launch', 'probe-status', 'probe-redirect', 'probe-build', 'sanitize'] as const)(
  'reports infrastructure failure at external boundaries: %s',
  async (failure) => {
    if (failure === 'launch') fixture.launch.mockRejectedValue(new Error('Browser absent'))
    if (failure.startsWith('probe-'))
      fixture.probe.mockResolvedValue({
        ok: () => failure !== 'probe-status',
        url: () => (failure === 'probe-redirect' ? 'http://foreign.invalid/' : 'http://fixture.invalid/build'),
        text: async () => (failure === 'probe-build' ? 'wrong' : 'build'),
      })
    if (failure === 'sanitize')
      fixture.destroy.mockImplementation(async () => {
        await rm(dir, { recursive: true, force: true })
      })
    await runWorker(input, emit)
    expect(events.at(-1)).toMatchObject({ type: 'finished', cleanup: failure === 'sanitize' ? 'unknown' : 'confirmed' })
  },
)
it('honors cancellation before launch, between cases and within a case', async () => {
  const before = runWorker(input, emit)
  stop('SIGINT')
  await before
  expect(fixture.launch).not.toHaveBeenCalled()
  fixture.newContext
    .mockReset()
    .mockResolvedValueOnce({ request: { get: fixture.probe }, close: vi.fn() })
    .mockResolvedValue(context)
  events = []
  await runWorker(input, (event) => {
    emit(event)
    if (event && typeof event === 'object' && 'type' in event && event.type === 'case-start')
      stop('message', { type: 'cancel' })
  })
  expect(result()).toMatchObject({ result: { status: 'infrastructure-error' } })
})
it('handles malformed cancellation and parent disconnect without losing escalation', async () => {
  fixture.connect.mockImplementation(async () => {
    stop('message', null)
    stop('disconnect')
    return { newContext: fixture.newContext }
  })
  await runWorker(input, emit)
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(events).toContainEqual({ type: 'infrastructure-error' })
  expect(fixture.spawn).toHaveBeenCalledOnce()
})
it('serves owned-tree termination and rejects invalid worker entry calls', async () => {
  await workerMain(['--terminate-tree', String(process.ppid), '12345'])
  expect(fixture.terminate).toHaveBeenCalledWith(process.ppid, 12345)
  await workerMain(['--terminate-tree', String(process.ppid), '0'])
  await expect(workerMain(['--terminate-tree', '1', '0'])).rejects.toThrow()
  await expect(workerMain(['invalid'])).rejects.toThrow()
})

it('validates initial IPC before side effects and closes the private channel after completion', async () => {
  const disconnect = vi.fn()
  const publish = vi.fn((_event: unknown, acknowledge: (error: Error | null) => void) => { acknowledge(null) })
  host.send = publish
  host.connected = true
  host.disconnect = disconnect
  const once = vi.spyOn(lifecycle, 'once')
  async function deliver(value: unknown): Promise<void> {
    once.mockClear()
    const work = workerMain(['--worker'])
    const handler = once.mock.calls.find(call => call[0] === 'message')?.[1]
    if (!handler) throw new Error('No worker handler')
    lifecycle.emit('message', value)
    await work
  }
  for (const value of [
    null,
    {},
    { ...input, runDir: 'relative' },
    { ...input, runDir: '/other' },
    { ...input, maxSteps: 0 },
    { ...input, maxSteps: 1.5 },
    { ...input, cleanupTimeoutMs: 0 },
    { ...input, cleanupTimeoutMs: 0.5 },
    { ...input, executablePath: 1 },
  ])
    await expect(deliver(value)).rejects.toThrow()
  await deliver({ ...input, storageState: { cookies: [], origins: [] }, executablePath: '/chromium' })
  expect(disconnect).toHaveBeenCalled()
  expect(publish).toHaveBeenCalledWith({ type: 'finished', cleanup: 'confirmed' }, expect.any(Function))
  const disconnectCount = disconnect.mock.calls.length
  host.connected = false
  publish.mockImplementation((_event, acknowledge) => { acknowledge(new Error('IPC channel closed')) })
  fixture.newContext
    .mockReset()
    .mockResolvedValueOnce({ request: { get: fixture.probe }, close: vi.fn() })
    .mockResolvedValue(context)
  await deliver(input)
  expect(disconnect).toHaveBeenCalledTimes(disconnectCount)
  publish.mockImplementation(() => {
    throw 'Broken IPC channel'
  })
  await expect(deliver(input)).rejects.toThrow('Worker failed')
  delete host.send
  await expect(workerMain(['--worker'])).rejects.toThrow('IPC')
})
it('stops at the case boundary and suppresses expected screenshot errors during cancellation', async () => {
  input.suite.cases.push({ id: 'later', steps: [{ kind: 'assert', prompt: 'Later' }] })
  fixture.screenshot.mockRejectedValue(new Error('Closed'))
  fixture.assert.mockImplementation(async () => {
    stop('SIGTERM')
  })
  await runWorker(input, emit)
  expect(events.filter(e => e && typeof e === 'object' && 'type' in e && e.type === 'case-start')).toHaveLength(1)
})
it('rejects unknown cancellation payload variants and keeps orphan cleanup without a browser PID', async () => {
  const work = runWorker(input, emit)
  stop('message', {})
  stop('message', { type: 'unknown' })
  stop('disconnect')
  await work
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(fixture.spawn).toHaveBeenCalled()
})

it('uses the same private snapshot for authenticated JSON probes and isolated cases and detects restarts', async () => {
  input.storageState = { cookies: [], origins: [] }
  input.suite.buildProbe = { path: '/build', expected: 'build', method: 'POST', format: 'json', field: ['value', 'buildId'], instanceField: ['value', 'instanceId'] }
  const response = (instanceId: string) => ({ ok: () => true, url: () => 'http://fixture.invalid/build', text: async () => JSON.stringify({ value: { buildId: 'build', instanceId } }) })
  fixture.probe.mockResolvedValueOnce(response('first')).mockResolvedValueOnce(response('second'))
  fixture.newContext.mockReset().mockResolvedValueOnce({ request: { post: fixture.probe }, close: vi.fn() }).mockResolvedValue(context)
  await runWorker(input, emit)
  expect(fixture.newContext.mock.calls).toEqual([[{ storageState: input.storageState }], [{ storageState: input.storageState }]])
  expect(events).toContainEqual({ type: 'infrastructure-error' })
  expect(fixture.probe).toHaveBeenCalledTimes(2)
  expect(fixture.probe).toHaveBeenCalledWith('http://fixture.invalid/build', { data: {}, maxRedirects: 0 })
})

it('checks served client bytes and rejects unavailable JSON identity fields', async () => {
  const { createHash } = await import('node:crypto')
  input.suite.buildProbe = { path: '/build', expected: 'build', format: 'json', field: ['value', 'buildId'], instanceField: ['value', 'instanceId'] }
  const digest = createHash('sha256').update('client').digest('hex')
  for (const client of [{ path: '/plugins/ui/client.js', sha256: digest }, { path: '/plugins/ui/client.js', sha256: 'wrong' }, null, {}, { path: 1 }, { path: '/', sha256: 1 }, { path: 'https://elsewhere.invalid/client.js', sha256: digest }]) {
    events.length = 0
    fixture.probe.mockImplementation(async (url: string) => url.includes('/plugins/')
      ? { ok: () => true, body: async () => Buffer.from('client') }
      : { ok: () => true, url: () => 'http://fixture.invalid/build', text: async () => JSON.stringify({ value: { buildId: 'build', instanceId: 'one', client } }) })
    fixture.newContext.mockReset().mockResolvedValueOnce({ request: { get: fixture.probe }, close: vi.fn() }).mockResolvedValue(context)
    await runWorker(input, emit)
    if (client && typeof client.path === 'string' && client.path.startsWith('/plugins/') && client.sha256 === digest) expect(events).not.toContainEqual({ type: 'infrastructure-error' })
    else expect(events).toContainEqual({ type: 'infrastructure-error' })
  }
  for (const value of [{ value: { buildId: 'build', instanceId: '' } }, { value: null }, { value: { buildId: 'other' } }]) {
    events.length = 0
    fixture.probe.mockResolvedValue({ ok: () => true, url: () => 'http://fixture.invalid/build', text: async () => JSON.stringify(value) })
    fixture.newContext.mockReset().mockResolvedValueOnce({ request: { get: fixture.probe }, close: vi.fn() }).mockResolvedValue(context)
    await runWorker(input, emit)
    expect(events).toContainEqual({ type: 'infrastructure-error' })
  }
})

it('stops before sending protected-page failures to the model and scrubs snapshot values from reports', async () => {
  input.storageState = { cookies: [{ name: 'session', value: 'fixture-token-secret', domain: 'fixture.invalid', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [{ origin: 'http://fixture.invalid', localStorage: [{ name: 'short', value: 'a' }, { name: 'token', value: 'long-token' }] }] }
  fixture.goto.mockResolvedValue({ status: () => 401 })
  await runWorker(input, emit)
  expect(fixture.assert).not.toHaveBeenCalled()
  expect(result()).toMatchObject({ result: { status: 'infrastructure-error' } })
  expect(await readFile(join(dir, 'case-0.html'), 'utf8')).not.toContain('fixture-token-secret')
})

it('refuses JSON probes without the selected build field even when invoked directly', async () => {
  input.suite.buildProbe = { path: '/build', expected: 'build', format: 'json' }
  input.storageState = { cookies: [{ name: 'short', value: 'a', domain: 'fixture.invalid', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }
  fixture.probe.mockResolvedValue({ ok: () => true, url: () => 'http://fixture.invalid/build', text: async () => '{}' })
  await runWorker(input, emit)
  expect(events).toContainEqual({ type: 'infrastructure-error' })
})

it('redacts short model keys without corrupting formal report JSON literals and numbers', async () => {
  for (const key of ['true', '1234', 'a']) {
    vi.stubEnv('MIDSCENE_MODEL_API_KEY', key)
    const path = join(dir, 'short-secret.json')
    await writeFile(path, JSON.stringify({ ok: true, count: 1234, credential: key, authorization: `Bearer ${key}` }))
    await runWorker(input, emit)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ok: true, count: 1234, credential: '[REDACTED]', authorization: 'Bearer [REDACTED]' })
  }
})
