/** Local durable provider. SQLite files must be on a local filesystem shared by host instances. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import GitHubSync from '@zhchxiao123/dsh-github-sync'
import type {
  Change,
  Snapshot,
  Subscription,
  SubscriptionInput,
  SyncRequest,
  SyncReceipt,
  SyncRun,
  StorageUsage,
} from '@zhchxiao123/dsh-github-sync'
import { Database } from './database.ts'
import { GitHub } from './github.ts'
import type { Incoming } from './github.ts'
import { validate } from './validate.ts'
import { installCommands } from './commands.ts'
import { installScheduler } from './scheduler.ts'
export interface Config {
  databasePath: string
  apiUrl: string
  graphqlUrl: string
  pollIntervalMs: number
  leaseMs: number
  concurrency: number
  pageSize: number
  maxPages: number
  requestTimeoutMs: number
  retryLimit: number
  retryDelayMs: number
  maxRetryDelayMs: number
  overlapMs: number
  reconcileIntervalMs: number
  capacityBytes: number
}
export const Config: z<Config> = z.object({
  databasePath: z.string().default('.github-sync/state.sqlite'),
  apiUrl: z.string().default('https://api.github.com'),
  graphqlUrl: z.string().default('https://api.github.com/graphql'),
  pollIntervalMs: z.number().min(10).default(1000),
  leaseMs: z.number().min(100).default(30000),
  concurrency: z.number().min(1).default(2),
  pageSize: z.number().min(1).max(100).default(100),
  maxPages: z.number().min(1).default(10000),
  requestTimeoutMs: z.number().min(1).default(30000),
  retryLimit: z.number().min(0).default(3),
  retryDelayMs: z.number().min(1).default(1000),
  maxRetryDelayMs: z.number().min(1).default(3600000),
  overlapMs: z.number().min(0).default(60000),
  reconcileIntervalMs: z.number().min(1).default(86400000),
  capacityBytes: z.number().min(1).default(1073741824),
})
class CapacityError extends Error {}
function nonempty(value: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Expected non-empty identifier')
}
function subscriptionInput(input: Omit<SubscriptionInput, 'projectId'>): void {
  nonempty(input.actor)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository))
    throw new Error('Expected owner/repository')
  if (
    typeof input.issues !== 'boolean' ||
    typeof input.discussions !== 'boolean' ||
    (!input.issues && !input.discussions)
  )
    throw new Error('Select at least one content type')
  if (
    input.credentialRef !== undefined &&
    !/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(input.credentialRef)
  )
    throw new Error('Credential reference must be env:VARIABLE')
}
export class LocalGitHubSync extends GitHubSync {
  static Config = Config
  readonly db: Database
  readonly owner = randomUUID()
  readonly active = new Map<
    string,
    { controller: AbortController; fence: number }
  >()
  private readonly pending = new Set<Promise<void>>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private healthError: string | undefined
  readonly config: Config
  private disposed = false
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = Config(config)
    for (const [key, value] of Object.entries(this.config))
      if (typeof value === 'number' && !Number.isSafeInteger(value))
        throw new Error(`Invalid integer configuration: ${key}`)
    for (const url of [this.config.apiUrl, this.config.graphqlUrl]) {
      const parsed = new URL(url)
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error('Invalid GitHub endpoint')
    }
    this.db = new Database(this.config.databasePath)
    const timer = setInterval(() => {
      this.poll()
    }, this.config.pollIntervalMs)
    const heartbeat = setInterval(
      () => {
        this.renew()
      },
      Math.max(1, Math.floor(this.config.leaseMs / 3)),
    )
    ctx.effect(() => async () => {
      this.disposed = true
      this.listeners.clear()
      clearInterval(timer)
      clearInterval(heartbeat)
      for (const { controller } of this.active.values()) controller.abort()
      await Promise.allSettled(this.pending)
      this.db.sql.close()
    })
    installScheduler(ctx, this)
    installCommands(ctx, this)
    queueMicrotask(() => {
      this.poll()
    })
  }
  private assigned(subscription: Subscription): void {
    if (!subscription.projectId) throw new Error('PROJECT_REQUIRED')
  }
  unassignedSubscriptions(): Promise<Subscription[]> {
    return this.subscriptions().then(rows => rows.filter(row => row.projectId === null))
  }
  claimSubscription(id: string, projectId: string, actor: string): Promise<Subscription> {
    return Promise.resolve().then(() => {
      nonempty(projectId)
      nonempty(actor)
      return this.db.transaction(() => {
        const old = this.subscription(id)
        if (old.projectId !== null) throw new Error('PROJECT_ALREADY_ASSIGNED')
        const claimed = { ...old, projectId, actor, paused: true, revision: old.revision + 1 }
        this.db.sql.prepare('UPDATE subscriptions SET data=? WHERE id=?').run(JSON.stringify(claimed), id)
        for (const run of this.db.records<SyncRun>('SELECT data FROM runs WHERE subscription=?', id)) {
          const active = ['queued', 'running', 'waiting'].includes(run.status)
          this.db.saveRun({ ...run, subscriptionSnapshot: { ...run.subscriptionSnapshot, projectId },
            ...(active ? { status: 'failed', error: 'PROJECT_CLAIM_REQUIRES_RESUME', fence: run.fence + 1, completedAt: Date.now() } : {}) })
        }
        return claimed
      })
    })
  }
  createSubscription(input: SubscriptionInput): Promise<Subscription> {
    return Promise.resolve().then(() => {
      nonempty(input.projectId)
      subscriptionInput(input)
      const subscription: Subscription = {
        ...input,
        id: randomUUID(),
        paused: false,
        revision: 1,
      }
      this.db.sql
        .prepare('INSERT INTO subscriptions VALUES(?,?)')
        .run(subscription.id, JSON.stringify(subscription))
      return subscription
    })
  }
  private subscription(id: string, projectId?: string): Subscription {
    const value = this.db.records<Subscription>(
      'SELECT data FROM subscriptions WHERE id=?',
      id,
    )[0]
    if (!value || (projectId !== undefined && value.projectId !== projectId)) throw new Error('Unknown subscription')
    subscriptionInput(value)
    return { ...value, projectId: value.projectId ?? null }
  }
  updateSubscription(
    id: string,
    patch: Partial<SubscriptionInput> & { paused?: boolean; actor: string },
    projectId?: string,
  ): Promise<Subscription> {
    return Promise.resolve().then(() => {
      return this.db.transaction(() => {
        const old = this.subscription(id, projectId)
        this.assigned(old)
        if (patch.projectId !== undefined && patch.projectId !== old.projectId) throw new Error('PROJECT_MISMATCH')
        const next = { ...old, ...patch, id, revision: old.revision + 1 }
        subscriptionInput(next)
        const changed =
          old.repository !== next.repository ||
          old.issues !== next.issues ||
          old.discussions !== next.discussions
        if (changed) {
          if (
            this.db.records<SyncRun>(
              "SELECT data FROM runs WHERE subscription=? AND status IN ('queued','running','waiting')",
              id,
            ).length
          )
            throw new Error('Cancel active runs before changing scope')
          if (old.repository !== next.repository)
            throw new Error(
              'Create a new subscription to change repository identity',
            )
          delete next.lastSuccessAt
          delete next.lastReconcileAt
        }
        this.db.sql
          .prepare('UPDATE subscriptions SET data=? WHERE id=?')
          .run(JSON.stringify(next), id)
        return next
      })
    })
  }
  subscriptions(projectId?: string): Promise<Subscription[]> {
    return Promise.resolve().then(() => {
      return this.db
        .records<Subscription>('SELECT data FROM subscriptions')
        .map(row => this.subscription(row.id))
        .filter(row => projectId === undefined || row.projectId === projectId)
    })
  }
  sync(subscriptionId: string, request: SyncRequest, projectId?: string): Promise<SyncReceipt> {
    return Promise.resolve().then(() => {
      this.assigned(this.subscription(subscriptionId, projectId))
      nonempty(request.actor)
      const triggerId = request.triggerId ?? randomUUID()
      nonempty(triggerId)
      const receipt = this.db.transaction(() => {
        const previous = this.db.records<SyncRun>(
          'SELECT data FROM runs WHERE trigger=?',
          triggerId,
        )[0]
        if (previous) {
          if (previous.subscriptionId !== subscriptionId)
            throw new Error('Trigger belongs to another subscription')
          if (
            request.cancelRequested &&
            ['queued', 'running', 'waiting'].includes(previous.status)
          ) {
            this.db.saveRun({
              ...previous,
              status: 'cancelled',
              actor: request.actor,
              completedAt: Date.now(),
              fence: previous.fence + 1,
            })
          }
          return { runId: previous.id, acceptedAt: previous.acceptedAt }
        }
        const subscription = this.subscription(subscriptionId)
        if (subscription.paused && !request.cancelRequested)
          throw new Error('Subscription paused')
        if (
          !request.cancelRequested &&
          (this.capacityBlocked() || this.db.bytes() >= this.capacity())
        )
          throw new CapacityError('Storage capacity reached')
        const run: SyncRun = {
          id: randomUUID(),
          subscriptionId,
          subscriptionSnapshot: subscription,
          triggerId,
          actor: request.actor,
          acceptedAt: Date.now(),
          status: request.cancelRequested ? 'cancelled' : 'queued',
          ...(request.cancelRequested ? { completedAt: Date.now() } : {}),
          checkpointSequence: this.latest(subscriptionId),
          pageBudget: this.config.maxPages,
          pages: 0,
          objects: 0,
          retries: 0,
          fence: 0,
          leaseUntil: 0,
          owner: '',
          reconcile: request.reconcile ?? false,
        }
        this.db.saveRun(run)
        return { runId: run.id, acceptedAt: run.acceptedAt }
      })
      if (request.cancelRequested)
        this.active.get(receipt.runId)?.controller.abort()
      queueMicrotask(() => {
        this.poll()
      })
      return receipt
    })
  }
  resumeRun(id: string, actor: string, projectId?: string): Promise<SyncReceipt> {
    return Promise.resolve().then(() => {
      nonempty(actor)
      const receipt = this.db.transaction(() => {
        const run = this.db.records<SyncRun>(
          'SELECT data FROM runs WHERE id=?',
          id,
        )[0]
        if (!run) throw new Error('Unknown run')
        this.assigned(this.subscription(run.subscriptionId, projectId))
        if (run.status !== 'partial' && run.status !== 'failed')
          throw new Error('Only failed or partial runs can resume')
        if (
          this.db.sql
            .prepare(
              "SELECT 1 FROM runs WHERE subscription=? AND id<>? AND status IN ('queued','running','waiting')",
            )
            .get(run.subscriptionId, run.id)
        )
          throw new Error(
            'Another synchronization is pending; finish it before resuming',
          )
        const subscription = this.subscription(run.subscriptionId)
        if (
          run.subscriptionSnapshot.repository !== subscription.repository ||
          run.subscriptionSnapshot.issues !== subscription.issues ||
          run.subscriptionSnapshot.discussions !== subscription.discussions
        )
          throw new Error(
            'Subscription scope changed; start a new synchronization',
          )
        if (this.capacityBlocked() || this.db.bytes() >= this.capacity())
          throw new CapacityError('Storage capacity reached')
        if (this.latest(run.subscriptionId) !== run.checkpointSequence)
          throw new Error(
            'Newer synchronization changed content; start a new synchronization',
          )
        const resumed: SyncRun = {
          ...run,
          actor,
          status: 'queued',
          owner: '',
          leaseUntil: 0,
          fence: run.fence + 1,
          pageBudget: run.pages + this.config.maxPages,
        }
        delete resumed.completedAt
        delete resumed.error
        delete resumed.waitUntil
        this.db.saveRun(resumed)
        this.db.sql
          .prepare(
            "INSERT INTO audit(action,actor,at) VALUES('resume-run',?,?)",
          )
          .run(actor, Date.now())
        return { runId: id, acceptedAt: run.acceptedAt }
      })
      queueMicrotask(() => {
        this.poll()
      })
      return receipt
    })
  }
  run(id: string, projectId?: string): Promise<SyncRun | undefined> {
    return Promise.resolve().then(() => {
      const run = this.db.records<SyncRun>('SELECT data FROM runs WHERE id=?', id)[0]
      if (run && projectId !== undefined) this.subscription(run.subscriptionId, projectId)
      return run
    })
  }
  runs(subscriptionId?: string, projectId?: string): Promise<SyncRun[]> {
    return Promise.resolve().then(() => {
      if (subscriptionId !== undefined) this.subscription(subscriptionId, projectId)
      const runs = subscriptionId
        ? this.db.records<SyncRun>(
          'SELECT data FROM runs WHERE subscription=? ORDER BY rowid DESC',
          subscriptionId,
        )
        : this.db.records<SyncRun>('SELECT data FROM runs ORDER BY rowid DESC')
      return runs.filter(run => projectId === undefined || this.subscription(run.subscriptionId).projectId === projectId)
    })
  }
  cancel(id: string, actor: string, projectId?: string): Promise<void> {
    return Promise.resolve().then(() => {
      nonempty(actor)
      this.db.transaction(() => {
        const run = this.db.records<SyncRun>(
          'SELECT data FROM runs WHERE id=?',
          id,
        )[0]
        if (!run) throw new Error('Unknown run')
        this.assigned(this.subscription(run.subscriptionId, projectId))
        if (['queued', 'running', 'waiting'].includes(run.status))
          this.db.saveRun({
            ...run,
            status: 'cancelled',
            actor,
            fence: run.fence + 1,
            completedAt: Date.now(),
          })
      })
      this.active.get(id)?.controller.abort()
    })
  }
  snapshots(id: string, projectId?: string): Promise<Snapshot[]> {
    return Promise.resolve().then(() => {
      this.subscription(id, projectId)
      return this.db.records<Snapshot>(
        'SELECT data FROM snapshots WHERE subscription=? ORDER BY id',
        id,
      )
    })
  }
  storage(): Promise<StorageUsage> {
    return Promise.resolve().then(() => {
      const bytes = this.db.bytes()
      const audit = this.db.sql
        .prepare(
          "SELECT actor,at FROM audit WHERE action='capacity' ORDER BY sequence DESC LIMIT 1",
        )
        .get()
      return {
        ...(audit
          ? {
            capacityChangedBy: String(audit.actor),
            capacityChangedAt: Number(audit.at),
          }
          : {}),
        bytes,
        capacityBytes: this.capacity(),
        blocked: this.capacityBlocked() || bytes >= this.capacity(),
        ...(this.healthError ? { error: this.healthError } : {}),
      }
    })
  }
  watch(id: string, listener: () => void, projectId?: string): () => void {
    this.subscription(id, projectId)
    const listeners = this.listeners.get(id) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(id)
    }
  }
  private notify(id: string): void {
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener()
      } catch {
        /* Advisory consumer notifications cannot roll back committed content. */
      }
    }
  }
  private capacityBlocked(): boolean {
    return (
      this.db.sql
        .prepare("SELECT value FROM settings WHERE key='capacityBlocked'")
        .get()?.value === 1
    )
  }
  private blockCapacity(error: unknown): void {
    if (error instanceof CapacityError)
      this.db.sql
        .prepare(
          "INSERT INTO settings VALUES('capacityBlocked',1) ON CONFLICT(key) DO UPDATE SET value=1",
        )
        .run()
  }
  private capacity(): number {
    return Number(
      this.db.sql
        .prepare("SELECT value FROM settings WHERE key='capacity'")
        .get()?.value ?? this.config.capacityBytes,
    )
  }
  setCapacity(bytes: number, actor: string): Promise<StorageUsage> {
    return Promise.resolve().then(() => {
      nonempty(actor)
      if (!Number.isSafeInteger(bytes) || bytes < 1)
        throw new Error('Invalid capacity')
      this.db.transaction(() => {
        this.db.sql
          .prepare(
            "INSERT INTO settings VALUES('capacity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(bytes)
        this.db.sql
          .prepare("INSERT INTO audit(action,actor,at) VALUES('capacity',?,?)")
          .run(actor, Date.now())
        this.db.sql
          .prepare("DELETE FROM settings WHERE key='capacityBlocked'")
          .run()
      })
      return this.storage()
    })
  }
  consumerState(
    id: string,
    consumerId: string,
    projectId?: string,
  ): Promise<{ acknowledged: number; delivered: number }> {
    return Promise.resolve().then(() => {
      this.assigned(this.subscription(id, projectId))
      return this.consumer(id, consumerId)
    })
  }
  private poll(): void {
    try {
      this.tick()
      this.healthError = undefined
    } catch (error) {
      this.healthError = String(error).replace(/^Error: /u, '')
    }
  }
  private renew(): void {
    // The timer is cleared synchronously at disposal; tick guards queued microtasks.
    for (const [id, { controller, fence }] of this.active) {
      try {
        this.db.transaction(() => {
          const run = this.db.fence(id, this.owner, fence)
          this.db.saveRun({
            ...run,
            leaseUntil: Date.now() + this.config.leaseMs,
          })
        })
      } catch {
        controller.abort()
      }
    }
  }
  private tick(): void {
    if (this.disposed) return
    this.renew()
    while (this.active.size < this.config.concurrency) {
      const run = this.db.transaction(() => {
        const runs = this.db.records<SyncRun>(
          "SELECT data FROM runs WHERE status IN ('queued','running','waiting') ORDER BY rowid",
        ).filter(item => this.subscription(item.subscriptionId).projectId !== null)
        if (
          runs.filter(
            item => item.status !== 'queued' && item.leaseUntil > Date.now(),
          ).length >= this.config.concurrency
        )
          return undefined
        const candidate = runs.find(
          (item, index) =>
            !runs
              .slice(0, index)
              .some(other => other.subscriptionId === item.subscriptionId) &&
            !this.active.has(item.id) &&
            (item.status === 'queued' || item.leaseUntil <= Date.now()),
        )
        if (!candidate) return undefined
        const claimed: SyncRun = {
          ...candidate,
          status: 'running',
          owner: this.owner,
          fence: candidate.fence + 1,
          leaseUntil: Date.now() + this.config.leaseMs,
        }
        this.db.saveRun(claimed)
        return claimed
      })
      if (!run) return
      const controller = new AbortController()
      this.active.set(run.id, { controller, fence: run.fence })
      const pending = this.execute(run, controller.signal).finally(() => {
        this.active.delete(run.id)
        this.pending.delete(pending)
      })
      this.pending.add(pending)
    }
  }
  private commit(
    run: SyncRun,
    incoming: Incoming[],
    seen: Set<string>,
    pageKey: string,
  ): void {
    this.db.transaction(() => {
      const current = this.db.fence(run.id, this.owner, run.fence)
      const hash = createHash('sha256')
        .update(JSON.stringify([pageKey, incoming]))
        .digest('hex')
      for (const item of incoming) seen.add(item.id)
      if (
        this.db.sql
          .prepare('SELECT 1 FROM committed_pages WHERE run=? AND hash=?')
          .get(run.id, hash)
      )
        return
      if (current.pages >= current.pageBudget)
        throw new Error('Run page budget exhausted; baseline incomplete')
      for (const item of incoming) {
        this.writeSnapshot(run.subscriptionId, item, false)
        seen.add(item.id)
      }
      const next = {
        ...current,
        status: 'running' as const,
        checkpointSequence: this.latest(run.subscriptionId),
        pages: current.pages + 1,
        objects: current.objects + incoming.length,
      }
      delete next.waitUntil
      this.db.saveRun(next)
      this.db.sql
        .prepare('INSERT INTO committed_pages VALUES(?,?)')
        .run(run.id, hash)
      if (this.db.bytes() > this.capacity())
        throw new CapacityError(
          'Storage capacity reached; increase capacity before resuming',
        )
    })
    this.notify(run.subscriptionId)
  }
  private writeSnapshot(
    subscriptionId: string,
    item: Incoming,
    deleted: boolean,
  ): void {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...item, deleted }))
      .digest('hex')
    const old = this.db.records<Snapshot>(
      'SELECT data FROM snapshots WHERE subscription=? AND id=?',
      subscriptionId,
      item.id,
    )[0]
    if (old?.fingerprint === fingerprint) return
    const snapshot: Snapshot = {
      ...item,
      subscriptionId,
      version: (old?.version ?? 0) + 1,
      fingerprint,
      fetchedAt: Date.now(),
      deleted,
    }
    this.db.sql
      .prepare(
        'INSERT INTO snapshots VALUES(?,?,?,?) ON CONFLICT(subscription,id) DO UPDATE SET version=excluded.version,data=excluded.data',
      )
      .run(subscriptionId, item.id, snapshot.version, JSON.stringify(snapshot))
    const change = {
      subscriptionId,
      objectId: item.id,
      version: snapshot.version,
      type: deleted ? 'deleted' : old ? 'updated' : 'created',
      snapshot,
    }
    this.db.sql
      .prepare(
        'INSERT INTO changes(subscription,object,version,data) VALUES(?,?,?,?)',
      )
      .run(subscriptionId, item.id, snapshot.version, JSON.stringify(change))
  }
  private async execute(run: SyncRun, signal: AbortSignal): Promise<void> {
    try {
      if (this.capacityBlocked())
        throw new CapacityError('Storage capacity reached')
      const subscription = run.subscriptionSnapshot
      const token = subscription.credentialRef
        ? process.env[subscription.credentialRef.slice(4)]
        : undefined
      if (subscription.credentialRef && !token)
        throw new Error('Credential reference unavailable')
      const client = new GitHub(
        this.config,
        token,
        signal,
        (retry, waitUntil) => {
          this.db.transaction(() => {
            const current = this.db.fence(run.id, this.owner, run.fence)
            this.db.saveRun({
              ...current,
              status: 'waiting',
              retries: current.retries + Number(retry),
              waitUntil,
            })
          })
        },
        {
          get: (key) => {
            const row = this.db.sql
              .prepare('SELECT data FROM responses WHERE run=? AND request=?')
              .get(run.id, key)
            return typeof row?.data === 'string'
              ? (JSON.parse(row.data) as unknown)
              : undefined
          },
          put: (key, data) => {
            this.db.transaction(() => {
              this.db.fence(run.id, this.owner, run.fence)
              this.db.sql
                .prepare(
                  'INSERT INTO responses VALUES(?,?,?) ON CONFLICT(run,request) DO NOTHING',
                )
                .run(run.id, key, JSON.stringify(data))
              if (this.db.bytes() > this.capacity())
                throw new CapacityError('Storage capacity reached')
            })
          },
        },
      )
      const reconcile =
        run.reconcile ||
        !subscription.lastReconcileAt ||
        Date.now() - subscription.lastReconcileAt >=
          this.config.reconcileIntervalMs
      let failed = false
      const errors: string[] = []
      for (const kind of ['issue', 'discussion'] as const) {
        if (kind === 'issue' ? !subscription.issues : !subscription.discussions)
          continue
        const seen = new Set<string>()
        try {
          const pages =
            kind === 'issue'
              ? client.issues(
                subscription,
                !reconcile && subscription.lastSuccessAt
                  ? subscription.lastSuccessAt - this.config.overlapMs
                  : undefined,
              )
              : client.discussions(subscription)
          let pageIndex = 0
          for await (const page of pages) {
            signal.throwIfAborted()
            this.commit(run, page, seen, `${kind}:${pageIndex++}`)
          }
          if (reconcile || kind === 'discussion')
            this.db.transaction(() => {
              this.db.fence(run.id, this.owner, run.fence)
              for (const snapshot of this.db.records<Snapshot>(
                'SELECT data FROM snapshots WHERE subscription=?',
                run.subscriptionId,
              ))
                if (
                  snapshot.kind.startsWith(kind) &&
                  !snapshot.deleted &&
                  !seen.has(snapshot.id)
                ) {
                  const {
                    id,
                    kind: contentKind,
                    parentId,
                    url,
                    updatedAt,
                    title,
                    body,
                    state,
                  } = snapshot
                  this.writeSnapshot(
                    run.subscriptionId,
                    {
                      id,
                      kind: contentKind,
                      ...(parentId ? { parentId } : {}),
                      url,
                      updatedAt,
                      title,
                      body,
                      state,
                    },
                    true,
                  )
                }
              const checkpoint = this.db.fence(run.id, this.owner, run.fence)
              this.db.saveRun({
                ...checkpoint,
                checkpointSequence: this.latest(run.subscriptionId),
              })
              if (this.db.bytes() > this.capacity())
                throw new CapacityError('Storage capacity reached')
            })
          this.notify(run.subscriptionId)
        } catch (error) {
          this.blockCapacity(error)
          signal.throwIfAborted()
          failed = true
          errors.push(
            `${kind}: ${String(error).replace(/^Error: /u, '')}`,
          )
        }
      }
      this.db.transaction(() => {
        const current = this.db.fence(run.id, this.owner, run.fence)
        this.db.saveRun({
          ...current,
          status: failed ? (current.pages ? 'partial' : 'failed') : 'succeeded',
          completedAt: Date.now(),
          ...(failed ? { error: errors.join('; ') } : {}),
        })
        if (!failed) {
          const latest = this.subscription(run.subscriptionId)
          this.db.sql.prepare('UPDATE subscriptions SET data=? WHERE id=?').run(
            JSON.stringify({
              ...latest,
              lastSuccessAt: run.acceptedAt,
              ...(reconcile ? { lastReconcileAt: Date.now() } : {}),
            }),
            latest.id,
          )
        }
      })
    } catch (error) {
      if (this.disposed) return
      this.blockCapacity(error)
      try {
        this.db.transaction(() => {
          const current = this.db.fence(run.id, this.owner, run.fence)
          this.db.saveRun({
            ...current,
            // Cancellation and lease-loss aborts revoke the fence before reaching here.
            status: current.pages ? 'partial' : 'failed',
            completedAt: Date.now(),
            error: String(error).replace(/^Error: /u, ''),
          })
        })
      } catch {
        /* A revoked lease or remote cancellation already owns the terminal state. */
      }
    }
  }
  registerConsumer(
    subscriptionId: string,
    consumerId: string,
    from: 'beginning' | 'now',
    projectId?: string,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      nonempty(consumerId)
      this.assigned(this.subscription(subscriptionId, projectId))
      this.db.sql
        .prepare('INSERT OR IGNORE INTO consumers VALUES(?,?,?,?)')
        .run(
          subscriptionId,
          consumerId,
          from === 'now' ? this.latest(subscriptionId) : 0,
          from === 'now' ? this.latest(subscriptionId) : 0,
        )
    })
  }
  private latest(id: string): number {
    return Number(
      this.db.sql
        .prepare(
          'SELECT MAX(sequence) AS sequence FROM changes WHERE subscription=?',
        )
        .get(id)?.sequence ?? 0,
    )
  }
  private consumer(
    id: string,
    consumerId: string,
  ): { acknowledged: number; delivered: number } {
    const row = this.db.sql
      .prepare(
        'SELECT acknowledged,delivered FROM consumers WHERE subscription=? AND id=?',
      )
      .get(id, consumerId)
    if (
      !row ||
      typeof row.acknowledged !== 'number' ||
      typeof row.delivered !== 'number'
    )
      throw new Error('Unknown or corrupt consumer')
    return { acknowledged: row.acknowledged, delivered: row.delivered }
  }
  readChanges(
    id: string,
    consumerId: string,
    limit: number,
    projectId?: string,
  ): Promise<Change[]> {
    return Promise.resolve().then(() => {
      this.assigned(this.subscription(id, projectId))
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error('Invalid page limit')
      return this.db.transaction(() => {
        this.assigned(this.subscription(id, projectId))
        const consumer = this.consumer(id, consumerId)
        const rows = this.db.sql
          .prepare(
            'SELECT sequence,data FROM changes WHERE subscription=? AND sequence>? ORDER BY sequence LIMIT ?',
          )
          .all(id, consumer.acknowledged, limit)
        const changes = rows.map((row) => {
          if (typeof row.data !== 'string' || typeof row.sequence !== 'number')
            throw new Error('Invalid change')
          const parsed: unknown = JSON.parse(row.data)
          validate(parsed)
          const value = parsed as Omit<Change, 'sequence' | 'id'>
          return { ...value, sequence: row.sequence, id: String(row.sequence) }
        })
        this.db.sql
          .prepare(
            'UPDATE consumers SET delivered=? WHERE subscription=? AND id=?',
          )
          .run(
            Math.max(consumer.delivered, changes.at(-1)?.sequence ?? 0),
            id,
            consumerId,
          )
        return changes
      })
    })
  }
  acknowledge(id: string, consumerId: string, sequence: number, projectId?: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.db.transaction(() => {
        this.assigned(this.subscription(id, projectId))
        const consumer = this.consumer(id, consumerId)
        const next = this.db.sql
          .prepare(
            'SELECT MIN(sequence) AS sequence FROM changes WHERE subscription=? AND sequence>?',
          )
          .get(id, consumer.acknowledged)?.sequence
        if (
          !Number.isSafeInteger(sequence) ||
          sequence !== next ||
          sequence > consumer.delivered
        )
          throw new Error('Acknowledge only the next delivered change')
        this.db.sql
          .prepare(
            'UPDATE consumers SET acknowledged=? WHERE subscription=? AND id=?',
          )
          .run(sequence, id, consumerId)
      })
    })
  }
  replay(
    id: string,
    consumerId: string,
    from: 'beginning' | 'now',
    projectId?: string,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      this.assigned(this.subscription(id, projectId))
      this.consumer(id, consumerId)
      const cursor = from === 'now' ? this.latest(id) : 0
      this.db.sql
        .prepare(
          'UPDATE consumers SET acknowledged=?,delivered=? WHERE subscription=? AND id=?',
        )
        .run(cursor, cursor, id, consumerId)
    })
  }
}
export default LocalGitHubSync
