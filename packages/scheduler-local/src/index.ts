import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Scheduler from '@zhchxiao123/dsh-scheduler'
import type { Plan, PlanInput, ScheduleHandler, Trigger } from '@zhchxiao123/dsh-scheduler'
import { installCommand } from './command.ts'
import { record, text, number, boolean, decodeInput } from './decode.ts'
import { latestTime, nextTime, validateInput } from './time.ts'
export interface Config {
  databasePath?: string
  pollIntervalMs?: number
  leaseMs?: number
  retryMs?: number
}
export const Config: z<Config> = z.object({
  databasePath: z.string().default('.scheduler/scheduler.sqlite'),
  pollIntervalMs: z.number().min(1).default(1000),
  leaseMs: z.number().min(1).default(30000),
  retryMs: z.number().min(1).default(1000),
})
interface StoredTrigger extends Trigger {
  owner: string
  generation: number
  leaseUntil: number
  retryAt: number
  handler: string
  params: unknown
  maxAttempts: number
  timeoutMs: number
  cancelRequested: boolean
}
/** Local-filesystem SQLite provider. Instances sharing the same database coordinate using fenced leases. */
export class LocalScheduler extends Scheduler {
  static Config = Config
  private readonly db: DatabaseSync
  private readonly handlers = new Map<string, ScheduleHandler>()
  private readonly owner = randomUUID()
  private readonly controllers = new Map<string, AbortController>()
  private readonly leaseMs: number
  private readonly retryMs: number
  private stopped = false
  private currentTick: Promise<void> | undefined
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.leaseMs = config.leaseMs ?? 30000
    this.retryMs = config.retryMs ?? 1000
    const databasePath = config.databasePath ?? '.scheduler/scheduler.sqlite'
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1) {
      this.db.close()
      throw new Error('UNSUPPORTED_SCHEMA_VERSION')
    }
    this.db.exec(
      'PRAGMA user_version=1; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, data TEXT NOT NULL);',
    )
    installCommand(ctx, this)
    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.tick().catch(() => {
          ctx.logger.warn('scheduler: TICK_FAILED; inspect durable state and database availability')
        })
      }, config.pollIntervalMs ?? 1000)
      timer.unref()
      return async () => {
        this.stopped = true
        clearInterval(timer)
        for (const controller of this.controllers.values()) controller.abort()
        await this.currentTick
        this.db.close()
      }
    })
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private rows(table: 'plans'): Plan[]
  private rows(table: 'triggers'): StoredTrigger[]
  private rows(table: 'plans' | 'triggers'): (Plan | StoredTrigger)[] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => {
        const value = record(JSON.parse(text(row.data)))
        if (table === 'plans') {
          const input = decodeInput(value)
          validateInput(input)
          return {
            ...input,
            id: text(value.id),
            enabled: boolean(value.enabled),
            deleted: boolean(value.deleted),
            nextAt: number(value.nextAt),
            createdBy: text(value.createdBy),
            updatedBy: text(value.updatedBy),
          }
        }
        const state = value.state
        if (
          state !== 'pending' &&
          state !== 'delivering' &&
          state !== 'accepted' &&
          state !== 'completed' &&
          state !== 'failed' &&
          state !== 'cancelled' &&
          state !== 'partial'
        )
          throw new Error('INVALID_TRIGGER_STATE')
        return {
          id: text(value.id),
          planId: text(value.planId),
          scheduledAt: number(value.scheduledAt),
          state,
          attempts: number(value.attempts),
          requestedBy: text(value.requestedBy),
          owner: text(value.owner),
          generation: number(value.generation),
          leaseUntil: number(value.leaseUntil),
          retryAt: number(value.retryAt),
          handler: text(value.handler),
          params: value.params,
          maxAttempts: number(value.maxAttempts),
          timeoutMs: number(value.timeoutMs),
          cancelRequested: boolean(value.cancelRequested),
          ...(value.runId !== undefined ? { runId: text(value.runId) } : {}),
          ...(value.error !== undefined ? { error: text(value.error) } : {}),
          ...(value.acceptedAt !== undefined ? { acceptedAt: number(value.acceptedAt) } : {}),
          ...(value.completedAt !== undefined ? { completedAt: number(value.completedAt) } : {}),
        }
      })
  }
  private save(table: 'plans' | 'triggers', value: Plan | StoredTrigger): void {
    this.db
      .prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .run(value.id, JSON.stringify(value))
  }
  private plan(id: string): Plan {
    const plan = this.rows('plans').find(value => value.id === id && !value.deleted)
    if (!plan) throw new Error('PLAN_NOT_FOUND')
    return plan
  }
  private requireActor(actor: string): void {
    if (!actor.trim()) throw new Error('ACTOR_REQUIRED')
  }
  registerHandler(name: string, handler: ScheduleHandler): () => void {
    if (!name.trim() || this.handlers.has(name)) throw new Error('HANDLER_EXISTS_OR_INVALID')
    this.handlers.set(name, handler)
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name)
    }
  }
  create(input: PlanInput, actor: string): Promise<Plan> {
    return Promise.resolve().then(() => {
      this.requireActor(actor)
      const params = validateInput(input)
      this.handlers.get(input.handler)?.validate(structuredClone(params))
      const plan: Plan = {
        ...input,
        params,
        id: randomUUID(),
        enabled: true,
        deleted: false,
        nextAt: nextTime(input.rule, Date.now()),
        createdBy: actor,
        updatedBy: actor,
      }
      this.save('plans', plan)
      return plan
    })
  }
  update(id: string, input: PlanInput, actor: string): Promise<Plan> {
    return Promise.resolve().then(() => {
      this.requireActor(actor)
      const params = validateInput(input)
      this.handlers.get(input.handler)?.validate(structuredClone(params))
      return this.transaction(() => {
        const current = this.plan(id)
        const plan = { ...current, ...input, params, nextAt: nextTime(input.rule, Date.now()), updatedBy: actor }
        this.save('plans', plan)
        return plan
      })
    })
  }
  list(): Promise<Plan[]> {
    return Promise.resolve().then(() => {
      return this.rows('plans').filter(plan => !plan.deleted)
    })
  }
  pause(id: string, actor: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.changeEnabled(id, false, actor)
    })
  }
  resume(id: string, actor: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.changeEnabled(id, true, actor)
    })
  }
  private changeEnabled(id: string, enabled: boolean, actor: string): void {
    this.requireActor(actor)
    this.transaction(() => {
      const plan = this.plan(id)
      this.save('plans', {
        ...plan,
        enabled,
        updatedBy: actor,
        nextAt: enabled ? nextTime(plan.rule, Date.now()) : plan.nextAt,
      })
    })
  }
  remove(id: string, actor: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.requireActor(actor)
      this.transaction(() => {
        this.save('plans', { ...this.plan(id), enabled: false, deleted: true, updatedBy: actor })
      })
    })
  }
  private enqueue(plan: Plan, scheduledAt: number, requestedBy: string, id: string): StoredTrigger {
    const trigger: StoredTrigger = {
      id,
      planId: plan.id,
      scheduledAt,
      requestedBy,
      state: 'pending',
      attempts: 0,
      owner: '',
      generation: 0,
      leaseUntil: 0,
      retryAt: 0,
      handler: plan.handler,
      params: plan.params,
      maxAttempts: plan.maxAttempts ?? 3,
      timeoutMs: plan.timeoutMs ?? 30000,
      cancelRequested: false,
    }
    this.save('triggers', trigger)
    return trigger
  }
  trigger(id: string, actor: string): Promise<Trigger> {
    return Promise.resolve().then(() => {
      this.requireActor(actor)
      return this.transaction(() => {
        const plan = this.plan(id)
        if (!plan.enabled) throw new Error('PLAN_PAUSED')
        return this.publicTrigger(this.enqueue(plan, Date.now(), actor, randomUUID()))
      })
    })
  }
  private publicTrigger(value: StoredTrigger): Trigger {
    const { id, planId, scheduledAt, state, attempts, requestedBy, runId, error, acceptedAt, completedAt } = value
    return {
      id,
      planId,
      scheduledAt,
      state,
      attempts,
      requestedBy,
      ...(runId !== undefined ? { runId } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(acceptedAt !== undefined ? { acceptedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
    }
  }
  history(id?: string): Promise<Trigger[]> {
    return Promise.resolve().then(() => {
      return this.rows('triggers')
        .filter(value => id === undefined || value.planId === id)
        .map(value => this.publicTrigger(value))
    })
  }
  async cancel(id: string, actor: string): Promise<void> {
    this.requireActor(actor)
    this.transaction(() => {
      const value = this.rows('triggers').find(row => row.id === id)
      if (!value) throw new Error('TRIGGER_NOT_FOUND')
      if (this.terminal(value)) return
      value.cancelRequested = true
      if (value.state === 'pending') {
        value.state = 'cancelled'
        value.completedAt = Date.now()
      }
      this.save('triggers', value)
    })
    this.controllers.get(id)?.abort()
    await this.tick()
  }
  private terminal(value: StoredTrigger): boolean {
    return ['completed', 'failed', 'cancelled', 'partial'].includes(value.state)
  }
  private claim(now: number): StoredTrigger[] {
    return this.transaction(() => {
      const triggers = this.rows('triggers')
      for (const plan of this.rows('plans')) {
        if (!plan.enabled || plan.deleted || plan.nextAt > now) continue
        const missed = nextTime(plan.rule, plan.nextAt) <= now
        if (
          !(plan.misfire === 'skip' && missed) &&
          !triggers.some(value => value.planId === plan.id && value.state === 'pending')
        ) {
          const scheduledAt = latestTime(plan.rule, plan.nextAt, now)
          triggers.push(this.enqueue(plan, scheduledAt, 'scheduler', `${plan.id}:${scheduledAt}`))
        }
        plan.nextAt =
          plan.rule.kind === 'interval'
            ? plan.nextAt + (Math.floor((now - plan.nextAt) / plan.rule.everyMs) + 1) * plan.rule.everyMs
            : nextTime(plan.rule, now)
        this.save('plans', plan)
      }
      const claimed: StoredTrigger[] = []
      for (const trigger of triggers) {
        if (this.terminal(trigger) || trigger.leaseUntil > now || trigger.retryAt > now) continue
        if (trigger.state === 'delivering' && !trigger.cancelRequested) {
          const plan = this.rows('plans').find(value => value.id === trigger.planId)
          if (!plan?.enabled || plan.deleted) continue
        }
        if (trigger.state === 'pending') {
          const plan = this.rows('plans').find(value => value.id === trigger.planId)
          if (!plan?.enabled || plan.deleted) continue
          if (
            triggers.some(
              value =>
                value.id !== trigger.id &&
                value.planId === trigger.planId &&
                ['delivering', 'accepted'].includes(value.state),
            )
          )
            continue
          if (!this.handlers.has(trigger.handler)) {
            trigger.error = 'HANDLER_UNAVAILABLE'
            this.save('triggers', trigger)
            continue
          }
          trigger.state = 'delivering'
        }
        if (!this.handlers.has(trigger.handler)) continue
        trigger.owner = this.owner
        trigger.generation++
        trigger.leaseUntil = now + this.leaseMs
        this.save('triggers', trigger)
        claimed.push(trigger)
      }
      return claimed
    })
  }
  private commit(claim: StoredTrigger, change: (current: StoredTrigger) => void): boolean {
    if (this.stopped) return false
    return this.transaction(() => {
      const current = this.rows('triggers').find(value => value.id === claim.id)
      if (
        !current ||
        current.owner !== this.owner ||
        current.generation !== claim.generation ||
        current.leaseUntil <= Date.now()
      )
        return false
      change(current)
      this.save('triggers', current)
      return true
    })
  }
  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.currentTick) return this.currentTick
    const claims = this.claim(Date.now())
    const work = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(claims.map(value => this.deliver(value)))
      for (const result of results) {
        if (result.status === 'rejected') throw new Error('DELIVERY_STORAGE_FAILED', { cause: result.reason })
      }
    })
    this.currentTick = work
    try {
      await work
    } finally {
      this.currentTick = undefined
    }
  }
  private async deliver(claim: StoredTrigger): Promise<void> {
    const handler = this.handlers.get(claim.handler)
    if (!handler) return
    const controller = new AbortController()
    this.controllers.set(claim.id, controller)
    const heartbeat = setInterval(
      () => {
        try {
          if (
            !this.commit(claim, (value) => {
              value.leaseUntil = Date.now() + this.leaseMs
              if (value.cancelRequested) controller.abort()
            })
          )
            controller.abort()
        } catch {
          controller.abort()
        }
      },
      Math.max(1, Math.floor(this.leaseMs / 3)),
    )
    const timeout = setTimeout(() => {
      controller.abort()
    }, claim.timeoutMs)
    try {
      if (claim.state === 'accepted' && claim.runId) {
        if (claim.cancelRequested) await bounded(handler.cancel(claim.runId), controller.signal)
        const status = await bounded(handler.status(claim.runId), controller.signal)
        this.commit(claim, (value) => {
          if (status.state !== 'running') {
            value.state = status.state
            value.completedAt = Date.now()
          }
          delete value.error
          if (status.error)
            value.error = /^[A-Z][A-Z0-9_]{0,63}$/.test(status.error) ? status.error : 'DOWNSTREAM_FAILED'
          value.leaseUntil = 0
        })
      } else {
        this.commit(claim, (value) => {
          value.attempts++
          claim.cancelRequested = value.cancelRequested
        })
        handler.validate(claim.params)
        const receipt = await bounded(
          handler.accept({
            triggerId: claim.id,
            cancelRequested: claim.cancelRequested,
            planId: claim.planId,
            params: claim.params,
            signal: controller.signal,
          }),
          controller.signal,
        )
        if (!receipt.runId) throw new Error('INVALID_RECEIPT')
        this.commit(claim, (value) => {
          value.state = 'accepted'
          value.runId = receipt.runId
          value.acceptedAt = Date.now()
          value.leaseUntil = 0
          delete value.error
        })
      }
    } catch {
      // Handler failures may contain credentials or remote bodies. Only ownership-specific error codes are persisted.
      this.commit(claim, (value) => {
        value.error = value.state === 'accepted' ? 'STATUS_UNAVAILABLE' : 'DELIVERY_FAILED'
        if (value.state !== 'accepted') {
          value.state = value.attempts >= value.maxAttempts && !value.cancelRequested ? 'failed' : 'delivering'
          if (value.cancelRequested) value.error = 'CANCELLATION_UNRESOLVED'
        }
        if (value.state === 'failed') value.completedAt = Date.now()
        value.retryAt = Date.now() + this.retryMs
        value.leaseUntil = 0
      })
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timeout)
      this.controllers.delete(claim.id)
    }
  }
}
export default LocalScheduler

/** Bound non-cooperative handlers; late settlement cannot re-enter the fenced commit path. */
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    throw new Error('ABORTED')
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new Error('ABORTED'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(new Error('HANDLER_FAILED', { cause: error }))
      },
    )
  })
}
