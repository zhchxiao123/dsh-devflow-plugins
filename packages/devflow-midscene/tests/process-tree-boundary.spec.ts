import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const boundary = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:util', async importOriginal => ({ ...await importOriginal<typeof import('node:util')>(), promisify: () => boundary.exec }))
import { terminateOwnedTree } from '../src/process-tree.ts'

let killSpy: MockInstance<typeof process.kill>
beforeEach(() => {
  boundary.exec.mockReset().mockResolvedValue({ stdout: '' })
  killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
})
afterEach(() => { vi.restoreAllMocks() })

it('rejects unsafe owner identities and invalid deadlines before issuing any process command', async () => {
  for (const pid of [0, 1, -1, NaN, 2.5, process.pid])
    await expect(terminateOwnedTree(pid)).rejects.toThrow('Invalid owned process')
  await expect(terminateOwnedTree(900001, process.pid)).rejects.toThrow('Invalid owned process')
  for (const timeout of [0, -1, NaN, 1.5])
    await expect(terminateOwnedTree(900001, undefined, timeout)).rejects.toThrow('Invalid termination timeout')
  expect(boundary.exec).not.toHaveBeenCalled()
  expect(killSpy).not.toHaveBeenCalled()
})

it('uses Windows tree termination with a bounded command and propagates command failure', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await terminateOwnedTree(900001, undefined, 100)
  expect(boundary.exec).toHaveBeenCalledWith('taskkill', ['/PID', '900001', '/T', '/F'], { timeout: 100, killSignal: 'SIGKILL' })
  boundary.exec.mockRejectedValueOnce(new Error('access denied'))
  await expect(terminateOwnedTree(900001)).rejects.toThrow('access denied')
})

it('discovers descendants across snapshots, excludes itself, and kills descendants before roots', async () => {
  boundary.exec.mockResolvedValueOnce({ stdout: `900002 900001\n${process.pid} 900001\n900003 900002\n900004 1\ninvalid\n` })
    .mockResolvedValueOnce({ stdout: '900002 900001\n900003 900002\n' })
  await terminateOwnedTree(900001)
  expect(killSpy.mock.calls).toEqual([
    [900001, 'SIGSTOP'], [900002, 'SIGSTOP'], [900003, 'SIGSTOP'],
    [900003, 'SIGKILL'], [900002, 'SIGKILL'], [900001, 'SIGKILL'],
  ])
})

it('treats already-exited processes as cleaned, but retains other signal errors', async () => {
  killSpy.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  await expect(terminateOwnedTree(900001)).resolves.toBeUndefined()
  killSpy.mockImplementation(() => { throw new Error('permission') })
  await expect(terminateOwnedTree(900001)).rejects.toThrow('permission')
  killSpy.mockImplementation(() => { throw 'non-error rejection' })
  await expect(terminateOwnedTree(900001)).rejects.toThrow('Process termination failed')
})

it('kills every known owner even when discovery or one kill fails', async () => {
  boundary.exec.mockRejectedValueOnce(new Error('ps failed'))
  await expect(terminateOwnedTree(900001, 900002)).rejects.toThrow('ps failed')
  expect(killSpy).toHaveBeenCalledWith(900002, 'SIGKILL')
  killSpy.mockClear().mockImplementation((pid, signal) => {
    if (pid === 900002 && signal === 'SIGKILL') throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return true
  })
  await expect(terminateOwnedTree(900001, 900002)).rejects.toThrow('denied')
  expect(killSpy).toHaveBeenCalledWith(900001, 'SIGKILL')
})

it('enforces discovery deadline and still terminates the stopped root', async () => {
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(101)
  await expect(terminateOwnedTree(900001, undefined, 100)).rejects.toThrow('Process discovery timed out')
  expect(killSpy).toHaveBeenCalledWith(900001, 'SIGKILL')
})

it('attempts the independently owned Windows browser tree even when the worker is already gone', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  boundary.exec.mockRejectedValueOnce(new Error('worker already exited')).mockResolvedValueOnce({ stdout: '' })
  await expect(terminateOwnedTree(900001, 900002, 100)).rejects.toThrow('worker already exited')
  expect(boundary.exec).toHaveBeenCalledWith('taskkill', ['/PID', '900002', '/T', '/F'], { timeout: 100, killSignal: 'SIGKILL' })
  boundary.exec.mockClear().mockRejectedValueOnce('command failed')
  await expect(terminateOwnedTree(900001, 900001)).rejects.toThrow('Process termination failed')
  expect(boundary.exec).toHaveBeenCalledTimes(1)
})
