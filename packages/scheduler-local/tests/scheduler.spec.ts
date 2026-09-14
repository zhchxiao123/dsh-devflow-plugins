import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import LocalScheduler from '../src/index.ts'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) await close()
})
async function boot(root?: string) {
  const dir = root ?? (await mkdtemp(join(tmpdir(), 'scheduler-')))
  const ctx = new Context()
  const fiber = ctx.plugin(LocalScheduler, {
    databasePath: join(dir, 'scheduler.sqlite'),
    pollIntervalMs: 60_000,
    leaseMs: 1000,
    retryMs: 100,
  })
  await fiber
  cleanup.unshift(async () => {
    await fiber.dispose()
    if (!root) await rm(dir, { recursive: true, force: true })
  })
  return { ctx, fiber, scheduler: ctx.scheduler, dir }
}
it('persists a due delivery without a chat and distinguishes acceptance from completion', async () => {
  const { scheduler } = await boot()
  let done = false
  scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      return { runId: 'durable-run' }
    },
    async status() {
      return { state: done ? 'completed' : 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  expect((await scheduler.history())[0]).toMatchObject({ state: 'accepted', runId: 'durable-run' })
  done = true
  await scheduler.tick()
  expect((await scheduler.history())[0]).toMatchObject({ state: 'completed' })
})
it('keeps one active run and coalesces waiting manual requests, then resumes after completion', async () => {
  const { scheduler } = await boot()
  let done = false
  let accepted = 0
  scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      return { runId: `run-${++accepted}` }
    },
    async status() {
      return { state: done ? 'completed' : 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  const waiting = await scheduler.trigger(plan.id, 'human')
  expect((await scheduler.trigger(plan.id, 'human')).id).not.toBe(waiting.id)
  await scheduler.tick()
  expect(accepted).toBe(1)
  done = true
  await scheduler.tick()
  await scheduler.tick()
  expect(accepted).toBe(2)
})
it('retries a lost receipt with the same identity across provider restarts', async () => {
  const { scheduler, dir, fiber } = await boot()
  const identities: string[] = []
  scheduler.registerHandler('test', {
    validate() {},
    async accept(value) {
      identities.push(value.triggerId)
      throw new Error('secret must not persist')
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  await fiber.dispose()
  const restarted = await boot(dir)
  restarted.scheduler.registerHandler('test', {
    validate() {},
    async accept(value) {
      identities.push(value.triggerId)
      return { runId: 'same-run' }
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() + 200)
  await restarted.scheduler.tick()
  expect(identities).toHaveLength(2)
  expect(identities[0]).toBe(identities[1])
  expect(JSON.stringify(await restarted.scheduler.history())).not.toContain('secret')
})
it('skips missing DST local times and schedules the next actual 02:30', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-08T06:00:00Z'))
  const plan = await scheduler.create(
    {
      name: 'daily',
      handler: 'test',
      params: {},
      rule: { kind: 'cron', expression: '30 2 * * *', timezone: 'America/New_York' },
    },
    'human',
  )
  expect(new Date(plan.nextAt).toISOString()).toBe('2026-03-09T06:30:00.000Z')
})
it('keeps interval anchors, merges offline periods and skips them when configured', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  const first = await scheduler.create(
    { name: 'latest', handler: 'absent', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  const second = await scheduler.create(
    { name: 'skip', handler: 'absent', params: {}, rule: { kind: 'interval', everyMs: 1000 }, misfire: 'skip' },
    'human',
  )
  vi.setSystemTime(15500)
  await scheduler.tick()
  expect(await scheduler.history(first.id)).toMatchObject([
    { scheduledAt: 15000, state: 'pending', error: 'HANDLER_UNAVAILABLE' },
  ])
  expect(await scheduler.history(second.id)).toEqual([])
  expect((await scheduler.list()).map(plan => plan.nextAt)).toEqual([16000, 16000])
})
it('bounds a handler ignoring abort and ignores its late receipt', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  let finish: (value: { runId: string }) => void = () => {}
  scheduler.registerHandler('test', {
    validate() {},
    accept() {
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    {
      name: 'test',
      handler: 'test',
      params: {},
      rule: { kind: 'interval', everyMs: 10000 },
      timeoutMs: 100,
      maxAttempts: 1,
    },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  const ticking = scheduler.tick()
  await vi.advanceTimersByTimeAsync(101)
  await ticking
  expect((await scheduler.history())[0]).toMatchObject({ state: 'failed', error: 'DELIVERY_FAILED' })
  finish({ runId: 'late' })
  await Promise.resolve()
  expect((await scheduler.history())[0]?.runId).toBeUndefined()
})
it('shares leases across instances and rejects the expired holder receipt', async () => {
  const first = await boot()
  const second = await boot(first.dir)
  vi.useFakeTimers()
  let finish: (value: { runId: string }) => void = () => {}
  let deliveries = 0
  first.scheduler.registerHandler('test', {
    validate() {},
    accept() {
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  second.scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      deliveries++
      return { runId: 'replacement' }
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await first.scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await first.scheduler.trigger(plan.id, 'human')
  const ticking = first.scheduler.tick()
  await second.scheduler.tick()
  expect(deliveries).toBe(0)
  vi.setSystemTime(Date.now() + 1001)
  await second.scheduler.tick()
  expect(deliveries).toBe(1)
  finish({ runId: 'obsolete' })
  await ticking
  expect((await first.scheduler.history())[0]).toMatchObject({ state: 'accepted', runId: 'replacement' })
})
it('pauses future delivery without cancelling accepted work and disposes handlers', async () => {
  const { scheduler } = await boot()
  let cancelled = false
  const dispose = scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      return { runId: 'run' }
    },
    async status() {
      return { state: cancelled ? 'cancelled' : 'running' }
    },
    async cancel() {
      cancelled = true
    },
  })
  const plan = await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  const trigger = await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  await scheduler.pause(plan.id, 'human')
  await scheduler.tick()
  expect(cancelled).toBe(false)
  await scheduler.cancel(trigger.id, 'human')
  expect((await scheduler.history())[0]?.state).toBe('cancelled')
  await expect(scheduler.trigger(plan.id, 'human')).rejects.toThrow('PLAN_PAUSED')
  await scheduler.resume(plan.id, 'human')
  dispose()
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  expect((await scheduler.history())[1]).toMatchObject({ state: 'pending', error: 'HANDLER_UNAVAILABLE' })
})
it('does not repeat an ambiguous local hour on a fall-back day', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T05:30:00Z'))
  const plan = await scheduler.create(
    {
      name: 'daily',
      handler: 'test',
      params: {},
      rule: { kind: 'cron', expression: '30 1 * * *', timezone: 'America/New_York' },
    },
    'human',
  )
  expect(new Date(plan.nextAt).toISOString()).toBe('2026-11-02T06:30:00.000Z')
})
it('retains manual requests in order, updates plans and removes only future work', async () => {
  const { scheduler } = await boot()
  let count = 0
  scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      return { runId: String(++count) }
    },
    async status() {
      return { state: 'completed' }
    },
    async cancel() {},
  })
  const input = { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval' as const, everyMs: 10000 } }
  const plan = await scheduler.create(input, 'human')
  await scheduler.update(plan.id, { ...input, name: 'changed' }, 'editor')
  const first = await scheduler.trigger(plan.id, 'a')
  const second = await scheduler.trigger(plan.id, 'b')
  expect(first.id).not.toBe(second.id)
  await scheduler.tick()
  await scheduler.tick()
  await scheduler.tick()
  expect(count).toBe(2)
  await scheduler.remove(plan.id, 'editor')
  await scheduler.tick()
  expect(await scheduler.list()).toEqual([])
  expect((await scheduler.history())[1]?.state).toBe('completed')
  await expect(scheduler.pause(plan.id, 'human')).rejects.toThrow('PLAN_NOT_FOUND')
  await expect(scheduler.cancel('unknown', 'human')).rejects.toThrow('TRIGGER_NOT_FOUND')
})
it('rejects invalid plan limits and parameters before preserving any record', async () => {
  const { scheduler } = await boot()
  const base = { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval' as const, everyMs: 10000 } }
  for (const input of [
    { ...base, name: '' },
    { ...base, handler: '' },
    { ...base, params: undefined },
    { ...base, maxAttempts: 0 },
    { ...base, timeoutMs: 0 },
    { ...base, rule: { kind: 'interval' as const, everyMs: 0 } },
    { ...base, rule: { kind: 'cron' as const, expression: '* * *', timezone: 'UTC' } },
    { ...base, rule: { kind: 'cron' as const, expression: '* * * * *', timezone: 'wrong' } },
  ])
    await expect(scheduler.create(input, 'human')).rejects.toThrow()
  await expect(scheduler.create(base, '')).rejects.toThrow('ACTOR_REQUIRED')
  expect(await scheduler.list()).toEqual([])
  const dispose = scheduler.registerHandler('test', {
    validate() {
      throw new Error('INVALID_HANDLER_PARAMS')
    },
    async accept() {
      return { runId: 'r' }
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  expect(() => scheduler.registerHandler('test', {} as never)).toThrow('HANDLER_EXISTS_OR_INVALID')
  await expect(scheduler.create(base, 'human')).rejects.toThrow('INVALID_HANDLER_PARAMS')
  dispose()
  dispose()
})
it('keeps accepted status failures separate from delivery attempts and redacts error bodies', async () => {
  const { scheduler } = await boot()
  let statusFails = true
  scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      return { runId: 'r' }
    },
    async status() {
      if (statusFails) throw new Error('remote secret')
      return { state: 'partial', error: 'token=private' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  await scheduler.tick()
  expect((await scheduler.history())[0]).toMatchObject({ state: 'accepted', error: 'STATUS_UNAVAILABLE', attempts: 1 })
  statusFails = false
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() + 101)
  await scheduler.tick()
  expect((await scheduler.history())[0]).toMatchObject({ state: 'partial', error: 'DOWNSTREAM_FAILED', attempts: 1 })
})
it('runs periodic work via host timers and stops promptly with non-cooperative work on disposal', async () => {
  const { scheduler, fiber } = await boot()
  vi.useFakeTimers()
  let attempts = 0
  scheduler.registerHandler('test', {
    validate() {},
    accept() {
      attempts++
      return new Promise(() => {})
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 }, timeoutMs: 120000 },
    'human',
  )
  // The provider timer was installed before fake timers; public reconciliation starts the same host work.
  vi.setSystemTime(Date.now() + 1001)
  const ticking = scheduler.tick()
  await Promise.resolve()
  expect(attempts).toBe(1)
  await fiber.dispose()
  await ticking
  await scheduler.tick()
})
it('coalesces cron downtime to the latest due wall time', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
  const plan = await scheduler.create(
    { name: 'daily', handler: 'absent', params: {}, rule: { kind: 'cron', expression: '30 9 * * *', timezone: 'UTC' } },
    'human',
  )
  vi.setSystemTime(new Date('2026-09-04T10:00:00Z'))
  await scheduler.tick()
  expect((await scheduler.history(plan.id))[0]?.scheduledAt).toBe(Date.parse('2026-09-04T09:30:00Z'))
})
it('renews an active lease while a slow handler runs and serializes simultaneous ticks', async () => {
  vi.useFakeTimers()
  const { scheduler } = await boot()
  let finish: (value: { runId: string }) => void = () => {}
  scheduler.registerHandler('test', {
    validate() {},
    accept() {
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  const first = scheduler.tick()
  const second = scheduler.tick()
  await vi.advanceTimersByTimeAsync(1400)
  finish({ runId: 'slow' })
  await Promise.all([first, second])
  expect((await scheduler.history())[0]?.runId).toBe('slow')
})
it('does not redeliver retries while paused and survives unavailable accepted handlers', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  let fail = true
  const handler = {
    validate() {},
    async accept() {
      if (fail) throw new Error('unavailable')
      return { runId: 'r' }
    },
    async status() {
      return { state: 'failed' as const, error: 'REMOTE_FAILURE' }
    },
    async cancel() {},
  }
  let dispose = scheduler.registerHandler('test', handler)
  const plan = await scheduler.create(
    { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  await scheduler.pause(plan.id, 'human')
  vi.setSystemTime(Date.now() + 101)
  await scheduler.tick()
  expect((await scheduler.history())[0]?.attempts).toBe(1)
  fail = false
  await scheduler.resume(plan.id, 'human')
  await scheduler.tick()
  dispose()
  await scheduler.tick()
  expect((await scheduler.history())[0]?.state).toBe('accepted')
  dispose = scheduler.registerHandler('test', handler)
  await scheduler.tick()
  expect((await scheduler.history())[0]).toMatchObject({ state: 'failed', error: 'REMOTE_FAILURE' })
  await scheduler.cancel((await scheduler.history())[0]!.id, 'human')
  dispose()
})
it('rejects invalid acceptance receipts and leaves paused pending requests untouched', async () => {
  const { scheduler } = await boot()
  scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      return { runId: '' }
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.pause(plan.id, 'human')
  await scheduler.tick()
  expect((await scheduler.history())[0]?.state).toBe('pending')
  await scheduler.resume(plan.id, 'human')
  await scheduler.tick()
  expect((await scheduler.history())[0]).toMatchObject({ state: 'delivering', error: 'DELIVERY_FAILED' })
})
it('refuses corrupted durable data and unknown storage versions', async () => {
  const { scheduler, dir } = await boot()
  const db = new DatabaseSync(join(dir, 'scheduler.sqlite'))
  try {
    const plan = await scheduler.create(
      { name: 'test', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
      'human',
    )
    db.prepare('UPDATE plans SET data=? WHERE id=?').run(JSON.stringify({ ...plan, enabled: 'invalid' }), plan.id)
    await expect(scheduler.list()).rejects.toThrow('INVALID_BOOLEAN')
    db.prepare('UPDATE plans SET data=? WHERE id=?').run(JSON.stringify({ ...plan, name: 1 }), plan.id)
    await expect(scheduler.list()).rejects.toThrow('INVALID_TEXT')
    db.prepare('UPDATE plans SET data=? WHERE id=?').run(JSON.stringify({ ...plan, nextAt: 'invalid' }), plan.id)
    await expect(scheduler.list()).rejects.toThrow('INVALID_NUMBER')
    db.prepare('UPDATE plans SET data=? WHERE id=?').run(JSON.stringify(plan), plan.id)
    const trigger = await scheduler.trigger(plan.id, 'human')
    db.prepare('UPDATE triggers SET data=? WHERE id=?').run(
      JSON.stringify({ ...trigger, state: 'invalid' }),
      trigger.id,
    )
    await expect(scheduler.history()).rejects.toThrow('INVALID_TRIGGER_STATE')
    db.exec('PRAGMA user_version=100')
    expect(() => new LocalScheduler(new Context(), { databasePath: join(dir, 'scheduler.sqlite') })).toThrow(
      'UNSUPPORTED_SCHEMA_VERSION',
    )
  } finally {
    db.close()
  }
})
it('skips a nonexistent local time during downtime reconciliation', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-06T06:00:00Z'))
  const plan = await scheduler.create(
    {
      name: 'daily',
      handler: 'absent',
      params: {},
      rule: { kind: 'cron', expression: '30 2 * * *', timezone: 'America/New_York' },
    },
    'human',
  )
  vi.setSystemTime(new Date('2026-03-08T10:00:00Z'))
  await scheduler.tick()
  expect((await scheduler.history(plan.id))[0]?.scheduledAt).toBe(Date.parse('2026-03-07T07:30:00Z'))
})
it('executes with provider defaults without a chat and reports corrupt storage at the host boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheduler-default-'))
  const previous = process.cwd()
  const ctx = new Context()
  vi.useFakeTimers()
  try {
    process.chdir(root)
    const scheduler = new LocalScheduler(ctx)
    scheduler.registerHandler('test', {
      validate() {},
      async accept() {
        return { runId: 'r' }
      },
      async status() {
        return { state: 'completed' }
      },
      async cancel() {},
    })
    const plan = await scheduler.create(
      { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
      'human',
    )
    await vi.advanceTimersByTimeAsync(1001)
    expect((await scheduler.history())[0]?.state).toBe('accepted')
    const db = new DatabaseSync(join(root, '.scheduler/scheduler.sqlite'))
    db.prepare('UPDATE plans SET data=? WHERE id=?').run('{}', plan.id)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(warn).toHaveBeenCalledWith('scheduler: TICK_FAILED; inspect durable state and database availability')
    warn.mockRestore()
    db.close()
  } finally {
    await ctx.fiber.dispose()
    process.chdir(previous)
    await rm(root, { recursive: true, force: true })
  }
})
it('coalesces periodic due work while waiting for an unavailable handler', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  const plan = await scheduler.create(
    { name: 't', handler: 'missing', params: {}, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  vi.setSystemTime(Date.now() + 1001)
  await scheduler.tick()
  vi.setSystemTime(Date.now() + 2000)
  await scheduler.tick()
  expect(await scheduler.history(plan.id)).toHaveLength(1)
})
it('aborts a stale holder when its heartbeat observes a replacement owner', async () => {
  const first = await boot()
  const second = await boot(first.dir)
  vi.useFakeTimers()
  first.scheduler.registerHandler('test', {
    validate() {},
    accept() {
      return new Promise(() => {})
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  second.scheduler.registerHandler('test', {
    validate() {},
    async accept() {
      return { runId: 'new' }
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await first.scheduler.create(
    { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await first.scheduler.trigger(plan.id, 'human')
  const pending = first.scheduler.tick()
  vi.setSystemTime(Date.now() + 1001)
  await second.scheduler.tick()
  await vi.advanceTimersByTimeAsync(334)
  await pending
  expect((await first.scheduler.history())[0]?.runId).toBe('new')
})
it('handles cancellation requested synchronously during durable acceptance', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  let cancellation: Promise<void> | undefined
  scheduler.registerHandler('test', {
    validate() {},
    async accept(delivery) {
      cancellation = scheduler.cancel(delivery.triggerId, 'human')
      return { runId: 'r' }
    },
    async status() {
      return { state: 'cancelled' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  await cancellation
  expect((await scheduler.history())[0]?.state).toBe('delivering')
})
it('halts an active operation when durable state becomes unreadable during renewal', async () => {
  const { scheduler, dir } = await boot()
  vi.useFakeTimers()
  scheduler.registerHandler('test', {
    validate() {},
    accept() {
      return new Promise(() => {})
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  const ticking = scheduler.tick()
  await Promise.resolve()
  const db = new DatabaseSync(join(dir, 'scheduler.sqlite'))
  db.exec('ALTER TABLE triggers RENAME TO unavailable_triggers')
  const rejected = expect(ticking).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(334)
  await rejected
  db.exec('ALTER TABLE unavailable_triggers RENAME TO triggers')
  db.close()
})
it('does not call a handler unloaded after a batch was claimed', async () => {
  const { scheduler } = await boot()
  const handler = {
    validate() {},
    async accept() {
      return { runId: 'r' }
    },
    async status() {
      return { state: 'running' as const }
    },
    async cancel() {},
  }
  const unload = scheduler.registerHandler('second', handler)
  scheduler.registerHandler('first', {
    ...handler,
    async accept() {
      unload()
      return { runId: 'r' }
    },
  })
  for (const name of ['first', 'second']) {
    const plan = await scheduler.create(
      { name, handler: name, params: {}, rule: { kind: 'interval', everyMs: 10000 } },
      'human',
    )
    await scheduler.trigger(plan.id, 'human')
  }
  await scheduler.tick()
  expect((await scheduler.history()).map(value => value.state)).toEqual(['accepted', 'delivering'])
})
it('observes another instance cancellation through lease renewal', async () => {
  const first = await boot()
  const second = await boot(first.dir)
  vi.useFakeTimers()
  first.scheduler.registerHandler('test', {
    validate() {},
    accept() {
      return new Promise(() => {})
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await first.scheduler.create(
    { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  const trigger = await first.scheduler.trigger(plan.id, 'human')
  const pending = first.scheduler.tick()
  await Promise.resolve()
  await second.scheduler.cancel(trigger.id, 'human')
  await vi.advanceTimersByTimeAsync(334)
  await pending
  expect((await first.scheduler.history())[0]?.error).toBe('CANCELLATION_UNRESOLVED')
})
it('consumes a rejected receipt after synchronous cancellation', async () => {
  const { scheduler } = await boot()
  let cancellation: Promise<void> | undefined
  scheduler.registerHandler('test', {
    validate() {},
    async accept(delivery) {
      cancellation = scheduler.cancel(delivery.triggerId, 'human')
      throw new Error('cancelled acceptance')
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const plan = await scheduler.create(
    { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 } },
    'human',
  )
  await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  await cancellation
  expect((await scheduler.history())[0]?.error).toBe('CANCELLATION_UNRESOLVED')
})
it('rejects lossy non-JSON parameters without running getters or changing saved plans', async () => {
  const { scheduler } = await boot()
  const base = {
    name: 'safe',
    handler: 'missing',
    params: { valid: true },
    rule: { kind: 'interval' as const, everyMs: 1000 },
  }
  const plan = await scheduler.create(base, 'human')
  let getterCalls = 0
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      getterCalls++
      return 'hidden'
    },
  })
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const symbolKey = { [Symbol('key')]: 'hidden' }
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        getterCalls++
        return undefined
      },
    },
  )
  const hidden = Object.defineProperty({}, 'hidden', { value: true })
  const sparse: unknown[] = []
  sparse.length = 2
  const invalidIndex: unknown[] = []
  invalidIndex.length = 1
  Object.defineProperty(invalidIndex, '4294967295', { value: 42, enumerable: true })
  const arrayProperty: unknown[] = []
  Object.defineProperty(arrayProperty, 'extra', { value: 1, enumerable: true })
  for (const params of [
    () => {},
    Symbol('value'),
    1n,
    undefined,
    { nested: undefined },
    NaN,
    Infinity,
    -Infinity,
    -0,
    {
      toJSON() {
        return 'different'
      },
    },
    circular,
    getter,
    proxy,
    symbolKey,
    hidden,
    sparse,
    invalidIndex,
    arrayProperty,
    new Date(),
    /regexp/,
  ]) {
    await expect(scheduler.create({ ...base, params }, 'human')).rejects.toThrow()
    await expect(scheduler.update(plan.id, { ...base, params }, 'human')).rejects.toThrow()
    expect(await scheduler.list()).toEqual([plan])
  }
  expect(getterCalls).toBe(0)
})
it('persists the validated JSON snapshot despite a mutating handler validator', async () => {
  const { scheduler } = await boot()
  scheduler.registerHandler('test', {
    validate(params) {
      if (typeof params === 'object' && params !== null)
        Object.defineProperty(params, 'bad', { value: undefined, enumerable: true })
    },
    async accept() {
      return { runId: 'r' }
    },
    async status() {
      return { state: 'running' }
    },
    async cancel() {},
  })
  const params = { data: [null, true, 'text', 42, { nested: false }] }
  const plan = await scheduler.create(
    { name: 't', handler: 'test', params, rule: { kind: 'interval', everyMs: 1000 } },
    'human',
  )
  expect(plan.params).toEqual(params)
  expect((await scheduler.list())[0]?.params).toEqual(params)
  const updated = await scheduler.update(
    plan.id,
    { ...plan, params: Object.assign(Object.create(null), { other: [] }) },
    'human',
  )
  expect(updated.params).toEqual({ other: [] })
  expect((await scheduler.list())[0]?.params).toEqual({ other: [] })
})
it('resolves ambiguous cancelled delivery with a tombstone instead of starting work', async () => {
  const { scheduler } = await boot()
  vi.useFakeTimers()
  let started = 0
  let accepting = true
  const runs = new Map<string, 'running' | 'cancelled'>()
  scheduler.registerHandler('test', {
    validate() {},
    async accept(delivery) {
      if (accepting) throw new Error('receipt unavailable')
      if (delivery.cancelRequested) runs.set(delivery.triggerId, 'cancelled')
      else if (!runs.has(delivery.triggerId)) {
        started++
        runs.set(delivery.triggerId, 'running')
      }
      return { runId: delivery.triggerId }
    },
    async status(runId) {
      return { state: runs.get(runId) ?? 'running' }
    },
    async cancel(runId) {
      runs.set(runId, 'cancelled')
    },
  })
  const plan = await scheduler.create(
    { name: 't', handler: 'test', params: {}, rule: { kind: 'interval', everyMs: 10000 }, maxAttempts: 2 },
    'human',
  )
  const trigger = await scheduler.trigger(plan.id, 'human')
  await scheduler.tick()
  await scheduler.cancel(trigger.id, 'human')
  vi.setSystemTime(Date.now() + 101)
  await scheduler.tick()
  expect((await scheduler.history())[0]).toMatchObject({
    state: 'delivering',
    error: 'CANCELLATION_UNRESOLVED',
    attempts: 2,
  })
  accepting = false
  vi.setSystemTime(Date.now() + 101)
  await scheduler.tick()
  await scheduler.tick()
  expect((await scheduler.history())[0]?.state).toBe('cancelled')
  expect(started).toBe(0)
})
