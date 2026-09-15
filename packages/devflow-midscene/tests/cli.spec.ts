import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RunOptions } from '../src/types.ts'
const doubles = vi.hoisted(() => ({
  run: vi.fn<(options: RunOptions) => Promise<{ status: string }>>(),
  inspect: vi.fn<(dir: string, timeout?: number) => Promise<{ status: string; reportAvailable: boolean }>>(),
  worker: vi.fn<(args: string[]) => Promise<void>>(),
}))
vi.mock('../src/runner.ts', () => ({ runAcceptance: doubles.run, inspectRun: doubles.inspect }))
vi.mock('../src/worker.ts', () => ({ workerMain: doubles.worker }))
let originalArgv: string[]
let originalExit: typeof process.exitCode
let stdout: string
let stderr: string
beforeEach(() => {
  originalArgv = process.argv
  originalExit = process.exitCode
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true })
  doubles.run.mockReset().mockResolvedValue({ status: 'passed' })
  doubles.inspect.mockReset().mockResolvedValue({ status: 'passed', reportAvailable: true })
  doubles.worker.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
})
afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExit
  vi.restoreAllMocks()
})
async function invoke(args: string[]): Promise<typeof process.exitCode> {
  process.argv = [process.execPath, '/fixture/cli.ts', ...args]
  await import('../src/cli.ts')
  return process.exitCode
}
const run = [
  'run', '--suite', 'suite.json', '--workspace', '/workspace', '--output', '/reports', '--card', '0001-card',
  '--build-id', 'build', '--model', 'model', '--timeout-ms', '1000', '--max-steps', '12', '--cleanup-timeout-ms', '100',
]
it('prints help without starting browser work and releases signal listeners', async () => {
  const before = process.listenerCount('SIGTERM')
  expect(await invoke(['--help'])).toBe(0)
  expect(stdout).toContain('dsh-midscene inspect')
  expect(doubles.run).not.toHaveBeenCalled()
  expect(process.listenerCount('SIGTERM')).toBe(before)
})
it('converts flags to bounded runner inputs, streams progress and forwards cancellation', async () => {
  doubles.run.mockImplementation((options) => {
    expect(options.timeoutMs).toBe(1000)
    expect(options.maxSteps).toBe(12)
    expect(options.cleanupTimeoutMs).toBe(100)
    expect(options.executablePath).toBe('/chromium')
    expect(options.reportBaseUrl).toBe('https://reports.example/')
    options.onProgress?.('case started')
    process.emit('SIGINT')
    expect(options.signal?.aborted).toBe(true)
    return Promise.resolve({ status: 'passed' })
  })
  expect(await invoke([...run, '--browser-executable-path', '/chromium', '--report-base-url', 'https://reports.example/'])).toBe(0)
  expect(stdout).toBe('case started\n')
})
it('returns nonzero for a failed run and omits optional flags', async () => {
  doubles.run.mockResolvedValue({ status: 'assertion-failed' })
  expect(await invoke(run)).toBe(1)
  expect(doubles.run.mock.calls[0]?.[0]).not.toHaveProperty('executablePath')
  expect(doubles.run.mock.calls[0]?.[0]).not.toHaveProperty('reportBaseUrl')
})
it('prints inspect data with an optional publication timeout', async () => {
  expect(await invoke(['inspect', '--run', '/reports/run', '--timeout-ms', '50'])).toBe(0)
  expect(doubles.inspect).toHaveBeenCalledWith('/reports/run', 50)
  expect(JSON.parse(stdout)).toEqual({ status: 'passed', reportAvailable: true })
})
it('returns nonzero for unknown inspection evidence using the default timeout', async () => {
  doubles.inspect.mockResolvedValue({ status: 'unknown', reportAvailable: false })
  expect(await invoke(['inspect', '--run', '/reports/run'])).toBe(1)
  expect(doubles.inspect).toHaveBeenCalledWith('/reports/run', undefined)
})
it.each([[], ['run'], ['run', '--suite', ''], ['--unknown']])('rejects malformed invocation %j', async (...values) => {
  const args = values.flat()
  expect(await invoke(args)).toBe(1)
  expect(stderr).toContain('infrastructure-error')
  expect(doubles.run).not.toHaveBeenCalled()
})
it.each([new Error('Expected object'), new Error('token=fixture-secret'), 'fixture-secret'])('redacts unsafe errors: %s', async (error) => {
  doubles.run.mockRejectedValue(error)
  expect(await invoke(run)).toBe(1)
  expect(stderr).not.toContain('fixture-secret')
})
it.each(['--worker', '--terminate-tree'])('delegates internal worker mode %s with owned arguments', async (mode) => {
  expect(await invoke([mode, '12', '13'])).toBe(0)
  expect(doubles.worker).toHaveBeenCalledWith([mode, '12', '13'])
  expect(doubles.run).not.toHaveBeenCalled()
})

it('forwards private login and deployment references without embedding their contents in arguments', async () => {
  expect(await invoke([...run, '--storage-state', '/private/login.json', '--deployment-record', '/private/build.json'])).toBe(0)
  expect(doubles.run.mock.calls[0]?.[0]).toMatchObject({ storageState: '/private/login.json', deploymentRecord: '/private/build.json' })
})
