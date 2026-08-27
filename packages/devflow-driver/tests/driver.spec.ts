// Driver behavior: configured stage entries dispatch one subagent per card
// under a claimed lease, the concurrency cap queues the rest, failed children
// park their card blocked, stale leases are taken over, revision regressions
// rescan quietly, and disposal stops dispatching.

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call,
 * typescript/no-unsafe-member-access, typescript/no-unsafe-argument --
 * `Promise.withResolvers` resolves to an error type here: the linter builds no
// program for files outside the packages' `include: ["src"]`, so it has neither
// the ES2024 lib nor our tsconfig. `pnpm run typecheck` does type these files.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor } from '@zhchxiao123/dsh-devflow'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as DevflowDriver from '@zhchxiao123/dsh-devflow-driver'
import { injectFsAccessDenied, resetFsFaults, runWithFsFault } from '../../../tests/fs-fault'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => runWithFsFault('readdir', args[0], () => actual.readdir(...args)),
  }
})

const HUMAN: DevActor = { kind: 'human', name: 'byclaw' }

interface StartedChild {
  prompt: string
  agentOptions: SubagentStartRequest['agentOptions']
  cwd: string | undefined
  settle: (result: SubagentResult) => void
  signal: AbortSignal
}

const MODEL_ROUTE = { provider: 'test-provider', model: 'test-model' }

/** Controllable provider: each start records its prompt and awaits manual settlement. */
function stubProvider(name: string, started: StartedChild[]): SubagentProvider {
  let seq = 0
  return {
    name,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start(request) {
      const settled = Promise.withResolvers<SubagentResult>()
      const promptText = request.prompt.map(block => block.type === 'text' ? block.text : '').join('')
      started.push({
        prompt: promptText,
        agentOptions: request.agentOptions,
        cwd: request.parent.session.header.cwd,
        settle: settled.resolve,
        signal: request.signal,
      })
      const run: SubagentRun = {
        id: SessionId(`stub-child-${++seq}`),
        localAgent: undefined,
        result: settled.promise,
        dispose: () => Promise.resolve(),
      }
      return Promise.resolve(run)
    },
  }
}

const COMPLETED: SubagentResult = { output: [], stopReason: 'completed' }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  resetFsFaults()
})

async function writeCard(id: string, journalLines: string[]): Promise<void> {
  const dir = join(root!, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${id}\n---\n\nObjective body of ${id}.\n`)
  await writeFile(join(dir, 'journal.jsonl'), journalLines.join('\n') + '\n')
}

const AT_READY = [
  '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
  '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
  '{"rev":3,"at":"t3","type":"transition","from":"designing","to":"ready"}',
]

interface Booted {
  store: FilesystemDevflowStore
  started: StartedChild[]
  ctx: Context
}

async function boot(config: Partial<DevflowDriver.Config> = {}): Promise<Booted> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
  const ctx = new Context()
  context = ctx
  const started: StartedChild[] = []
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(stubProvider('stub', started))
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  await ctx.plugin(DevflowDriver, {
    stages: { ready: { provider: 'stub', instructions: 'Take the card into development.' } },
    maxConcurrentCards: 1,
    ...config,
  }).await()
  return { store: ctx.get('devflow') as FilesystemDevflowStore, started, ctx }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('devflow-driver', () => {
  it('sweeps pre-existing cards at driven stages, claims, dispatches, and releases', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0001-a', AT_READY)
    const { started } = await boot()
    await until(() => started.length === 1, 'the sweep dispatch')
    expect(started[0].prompt).toContain('Take the card into development.')
    expect(started[0].prompt).toContain('devflow task card 0001-a at stage "ready"')
    expect(started[0].prompt).toContain('Objective body of 0001-a.')
    const claim = await readFile(join(root, 'tasks', '0001-a', 'claim.json'), 'utf8')
    expect(claim).toContain('"name": "devflow-driver"')
    started[0].settle(COMPLETED)
    // The lease is released after the child settles: a fresh claim succeeds.
    const store = context!.get('devflow') as FilesystemDevflowStore
    await vi.waitFor(async () => {
      const reclaim = await store.claim(DevflowCardId('0001-a'), HUMAN)
      expect(reclaim.ok).toBe(true)
      if (reclaim.ok) await reclaim.handle.release()
    })
  })

  it('passes the deployment model and card workspace routes to each child request', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0001-model-route', AT_READY)
    const { started } = await boot()
    await until(() => started.length === 1, 'the model-routed dispatch')
    expect(started[0].agentOptions).toEqual(MODEL_ROUTE)
    expect(started[0].cwd).toBe(dirname(root))
    started[0].settle(COMPLETED)
  })

  it('drives the children of a decomposed requirement, never the parent itself', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0001-big', AT_READY)
    await writeCard('0002-slice', [
      '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"},"parent":"0001-big"}',
      ...AT_READY.slice(1),
    ])
    const { started, ctx } = await boot({ maxConcurrentCards: 2 })
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => {})

    await until(() => started.length === 1, 'the child dispatch')
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('card 0001-big decomposes into 1 sub-requirement(s)'))
    expect(started[0].prompt).toContain('devflow task card 0002-slice at stage "ready"')
    // The parent occupies no lease: it was never a unit of executable work.
    await expect(readFile(join(root, 'tasks', '0001-big', 'claim.json'), 'utf8')).rejects.toThrow(/ENOENT/)
    started[0].settle(COMPLETED)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toHaveLength(1)
  })

  it('skips the dispatch when it cannot tell whether the card has sub-requirements', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    const unreadable = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-locked-'))
    await mkdir(join(unreadable, 'tasks'), { recursive: true })
    try {
      const { started, ctx } = await boot()
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      injectFsAccessDenied({ operation: 'readdir', path: join(unreadable, 'tasks') })
      ctx.emit('devflow/stage-changed', {
        id: DevflowCardId('0001-unreadable'),
        root: unreadable,
        title: 'Card in an unreadable root',
        stage: 'ready',
        stageRevision: 3,
        body: '',
        path: join(unreadable, 'tasks', '0001-unreadable', 'card.md'),
        artifacts: [],
      }, 'designing')
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot tell whether card 0001-unreadable has sub-requirements'))
      })
      expect(started).toHaveLength(0)
    } finally {
      await rm(unreadable, { recursive: true, force: true })
    }
  })

  it('claims and parks in the moved card\'s own root, not the configured default', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    const otherRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-b-'))
    try {
      const dir = join(otherRoot, 'tasks', '0001-elsewhere')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'card.md'), '---\ntitle: Elsewhere card\n---\n\nBody.\n')
      await writeFile(join(dir, 'journal.jsonl'), [
        '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
        '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
      ].join('\n') + '\n')
      const { store, started } = await boot()

      const moved = await store.transition(store.resolve({
        id: DevflowCardId('0001-elsewhere'), to: 'ready', expectedRevision: 2, by: HUMAN, root: otherRoot,
      }))
      expect(moved).toMatchObject({ ok: true })
      await until(() => started.length === 1, 'the cross-root dispatch')
      expect(started[0].cwd).toBe(dirname(otherRoot))
      // The lease lives in the card's root; the default root has no trace.
      const claim = await readFile(join(otherRoot, 'tasks', '0001-elsewhere', 'claim.json'), 'utf8')
      expect(claim).toContain('"name": "devflow-driver"')
      await expect(readFile(join(root, 'tasks', '0001-elsewhere', 'claim.json'), 'utf8')).rejects.toThrow(/ENOENT/)

      started[0].settle({ output: [], stopReason: 'refusal' })
      // The failure parks the card blocked in ITS root.
      await vi.waitFor(async () => {
        const journal = await readFile(join(otherRoot, 'tasks', '0001-elsewhere', 'journal.jsonl'), 'utf8')
        expect(journal).toContain('"to":"blocked"')
      })
    } finally {
      await rm(otherRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('drives a card on stage-changed and respects the concurrency cap', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0002-b', ['{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}'])
    await writeCard('0003-c', ['{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}'])
    const { store, started } = await boot()
    const moveToReady = async (id: string): Promise<void> => {
      for (const to of ['designing', 'ready'] as const) {
        const card = await store.read(DevflowCardId(id))
        const result = await store.transition(store.resolve({
          id: DevflowCardId(id), to, expectedRevision: card.stageRevision, by: HUMAN,
        }))
        expect(result.ok).toBe(true)
      }
    }
    await moveToReady('0002-b')
    await moveToReady('0003-c')
    await until(() => started.length === 1, 'the first dispatch')
    // The cap holds the second card until the first child settles.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(started).toHaveLength(1)
    started[0].settle(COMPLETED)
    await until(() => started.length === 2, 'the queued dispatch')
    started[1].settle(COMPLETED)
  })

  it('parks the card blocked when the child ends unsuccessfully', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0004-d', AT_READY)
    const { store, started } = await boot()
    await until(() => started.length === 1, 'the dispatch')
    started[0].settle({ output: [], stopReason: 'error', diagnostic: 'child crashed' })
    await vi.waitFor(async () => {
      const card = await store.read(DevflowCardId('0004-d'))
      expect(card).toMatchObject({ stage: 'blocked', blockedFrom: 'ready' })
    })
    const journal = await readFile(join(root, 'tasks', '0004-d', 'journal.jsonl'), 'utf8')
    expect(journal).toContain('stage executor for \\"ready\\" ended with error')
    expect(journal).toContain('"by":{"kind":"command","name":"devflow-driver"}')
  })

  it('warns when a failed child cannot even be parked', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0009-i', AT_READY)
    const { started, ctx } = await boot()
    await until(() => started.length === 1, 'the dispatch')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const journalPath = join(root, 'tasks', '0009-i', 'journal.jsonl')
    await chmod(journalPath, 0o444)
    try {
      started[0].settle({ output: [], stopReason: 'error' })
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('parking also failed'))
      })
    } finally {
      await chmod(journalPath, 0o644)
    }
  })

  it('skips a card whose lease is freshly held and takes over a stale one', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0005-e', AT_READY)
    const now = new Date().toISOString()
    await writeFile(join(root, 'tasks', '0005-e', 'claim.json'), JSON.stringify({
      owner: { kind: 'agent', session: 'other-worker' }, at: now, heartbeatAt: now,
    }, null, 2) + '\n')
    const fresh = await boot()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fresh.started).toHaveLength(0) // a live worker keeps the card

    await context!.fiber.dispose()
    context = undefined
    await writeFile(join(root, 'tasks', '0005-e', 'claim.json'), JSON.stringify({
      owner: { kind: 'agent', session: 'dead-worker' }, at: now, heartbeatAt: '2000-01-01T00:00:00Z',
    }, null, 2) + '\n')
    const stale = await boot({ claimStaleAfterMs: 60_000 })
    await until(() => stale.started.length === 1, 'the takeover dispatch')
    const journal = await readFile(join(root, 'tasks', '0005-e', 'journal.jsonl'), 'utf8')
    expect(journal).toContain('"type":"claim-expired"')
    expect(journal).toContain('dead-worker')
    stale.started[0].settle(COMPLETED)
  })

  it('rescans quietly on a revision regression without double-dispatching', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0006-f', AT_READY)
    const { started, ctx } = await boot()
    await until(() => started.length === 1, 'the sweep dispatch')
    const card = await (ctx.get('devflow') as FilesystemDevflowStore).read(DevflowCardId('0006-f'))
    // A branch switch replays an OLDER revision for an engaged card.
    ctx.emit('devflow/stage-changed', { ...card, stageRevision: card.stageRevision - 1 }, 'designing')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(started).toHaveLength(1)
    started[0].settle(COMPLETED)
  })

  it('does not redispatch an engaged card for a duplicate equal-revision event', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0006-duplicate', AT_READY)
    const { started, ctx, store } = await boot()
    await until(() => started.length === 1, 'the initial dispatch')
    const card = await store.read(DevflowCardId('0006-duplicate'))

    ctx.emit('devflow/stage-changed', card, 'designing')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toHaveLength(1)
    started[0].settle(COMPLETED)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(started).toHaveLength(1)
  })

  it('rescans a regressed idle card without scheduling an undriven stage', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0006-idle', ['{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}'])
    const { started, ctx, store } = await boot()
    const card = await store.read(DevflowCardId('0006-idle'))

    ctx.emit('devflow/stage-changed', card, 'blocked')
    ctx.emit('devflow/stage-changed', { ...card, stageRevision: card.stageRevision - 1 }, 'blocked')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(started).toHaveLength(0)
  })

  it('waits for providers registered after activation, then dispatches the pending cards', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0006-late-provider', AT_READY)
    await writeCard('0007-late-provider', AT_READY)
    await writeCard('0008-other-provider', [
      ...AT_READY,
      '{"rev":4,"at":"t4","type":"transition","from":"ready","to":"developing"}',
    ])
    const ctx = new Context()
    context = ctx
    const started: StartedChild[] = []
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => {})

    await ctx.plugin(DevflowDriver, {
      stages: {
        ready: { provider: 'late' },
        developing: { provider: 'other' },
      },
      maxConcurrentCards: 3,
    }).await()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toHaveLength(0)
    expect(debug).toHaveBeenCalledTimes(2)
    expect(debug).toHaveBeenCalledWith('devflow-driver: waiting for subagent provider "late"')
    expect(debug).toHaveBeenCalledWith('devflow-driver: waiting for subagent provider "other"')

    ctx.subagents.registerProvider(stubProvider('late', started))
    await until(() => started.length === 2, 'the dispatches after provider registration')
    expect(started.map(child => child.prompt)).toEqual(expect.arrayContaining([
      expect.stringContaining('devflow task card 0006-late-provider at stage "ready"'),
      expect.stringContaining('devflow task card 0007-late-provider at stage "ready"'),
    ]))
    ctx.subagents.registerProvider(stubProvider('other', started))
    await until(() => started.length === 3, 'the dispatch after the other provider registration')
    expect(started[2].prompt).toContain('devflow task card 0008-other-provider at stage "developing"')
    started[0].settle(COMPLETED)
    started[1].settle(COMPLETED)
    started[2].settle(COMPLETED)
  })

  it.each([
    { label: 'an undrivable stage', config: { stages: { done: { provider: 'stub' } }, maxConcurrentCards: 1 }, message: 'undrivable stage "done"' },
    { label: 'an unknown stage name', config: { stages: { parked: { provider: 'stub' } }, maxConcurrentCards: 1 }, message: 'undrivable stage "parked"' },
    { label: 'a non-positive cap', config: { stages: {}, maxConcurrentCards: 0 }, message: 'maxConcurrentCards must be a positive integer' },
    { label: 'a non-positive staleness window', config: { stages: {}, maxConcurrentCards: 1, claimStaleAfterMs: 0 }, message: 'claimStaleAfterMs must be a positive integer' },
  ])('fails the load on $label', async ({ config, message }) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(stubProvider('stub', []))
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    await expect(ctx.plugin(DevflowDriver, config as DevflowDriver.Config)).rejects.toThrow(message)
  })

  it('parks the card when the provider start itself rejects', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0008-h', AT_READY)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'explode',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('spawn backend down')),
    })
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    await ctx.plugin(DevflowDriver, { stages: { ready: { provider: 'explode' } }, maxConcurrentCards: 1 }).await()
    const store = ctx.get('devflow') as FilesystemDevflowStore
    await vi.waitFor(async () => {
      expect((await store.read(DevflowCardId('0008-h'))).stage).toBe('blocked')
    })
    const journal = await readFile(join(root, 'tasks', '0008-h', 'journal.jsonl'), 'utf8')
    expect(journal).toContain('spawn backend down')
  })

  it('warns when the activation sweep cannot list the board, and applies defaults under direct application', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await mkdir(join(root, 'tasks'), { recursive: true })
    const ctx = new Context()
    context = ctx
    const started: StartedChild[] = []
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(stubProvider('stub', started))
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    injectFsAccessDenied({ operation: 'readdir', path: join(root, 'tasks') })
    await ctx.inject(['devflow', 'subagents', 'agents'], (child: Context) => {
      DevflowDriver.apply(child, { maxConcurrentCards: 1 })
    })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed'))
    })
    expect(started).toHaveLength(0)
  })

  it('drives the next stage a running child moves its card into', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0010-j', AT_READY)
    const { store, started } = await boot({
      stages: {
        ready: { provider: 'stub' },
        developing: { provider: 'stub' },
      },
    })
    await until(() => started.length === 1, 'the ready dispatch')

    // What a stage executor does: it advances the card before it exits, so the
    // move arrives while the driver still holds the card engaged.
    const atReady = await store.read(DevflowCardId('0010-j'))
    const moved = await store.transition(store.resolve({
      id: DevflowCardId('0010-j'),
      to: 'developing',
      expectedRevision: atReady.stageRevision,
      by: { kind: 'agent', session: 'stub-child-1' },
    }))
    expect(moved.ok).toBe(true)
    started[0].settle(COMPLETED)

    await until(() => started.length === 2, 'the developing dispatch')
    expect(started[1].prompt).toContain('at stage "developing"')
  })

  it('leaves a card where it stands when its executor advanced it before failing', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0011-k', AT_READY)
    const { store, started } = await boot()
    await until(() => started.length === 1, 'the dispatch')

    const atReady = await store.read(DevflowCardId('0011-k'))
    await store.transition(store.resolve({
      id: DevflowCardId('0011-k'),
      to: 'developing',
      expectedRevision: atReady.stageRevision,
      by: { kind: 'agent', session: 'stub-child-1' },
    }))
    started[0].settle({ output: [], stopReason: 'error', diagnostic: 'crashed after advancing' })

    await vi.waitFor(async () => {
      expect((await store.read(DevflowCardId('0011-k'))).stage).toBe('developing')
    })
    const journal = await readFile(join(root, 'tasks', '0011-k', 'journal.jsonl'), 'utf8')
    expect(journal).not.toContain('"to":"blocked"')
  })

  it('rescans the regressed card\'s own root, not the default one', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    const otherRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-other-'))
    try {
      const otherDir = join(otherRoot, 'tasks', '0001-elsewhere')
      await mkdir(otherDir, { recursive: true })
      await writeFile(join(otherDir, 'card.md'), '---\ntitle: Elsewhere\n---\n\nBody.\n')
      await writeFile(join(otherDir, 'journal.jsonl'), AT_READY.join('\n') + '\n')
      const { store, started } = await boot()
      const card = await store.read(DevflowCardId('0001-elsewhere'), otherRoot)

      // The card enters through its own event; the activation sweep never
      // reached its root.
      context!.emit('devflow/stage-changed', card, 'designing')
      await until(() => started.length === 1, 'the dispatch in the other root')

      // A branch switch can replay an older revision while the old child is
      // still engaged. The rescan has to remember that root until the child
      // exits instead of dropping the card as a duplicate.
      context!.emit('devflow/stage-changed', { ...card, stageRevision: card.stageRevision - 1 }, 'designing')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(started).toHaveLength(1)
      started[0].settle(COMPLETED)
      await until(() => started.length === 2, 'the rescan dispatch in the other root')
      started[1].settle(COMPLETED)
    } finally {
      await rm(otherRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('stops dispatching and aborts running children on disposal (HMR safety)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-'))
    await writeCard('0007-g', AT_READY)
    const ctx = new Context()
    context = ctx
    const started: StartedChild[] = []
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(stubProvider('stub', started))
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    const driver = ctx.plugin(DevflowDriver, { stages: { ready: { provider: 'stub' } }, maxConcurrentCards: 1 })
    await driver.await()
    await until(() => started.length === 1, 'the dispatch')
    expect(ctx.agents.list()).toHaveLength(1)
    expect(started[0].signal.aborted).toBe(false)
    await driver.dispose()
    expect(started[0].signal.aborted).toBe(true)
    expect(ctx.agents.list()).toHaveLength(0)
    started[0].settle(COMPLETED)
    const store = ctx.get('devflow') as FilesystemDevflowStore
    const card = await store.read(DevflowCardId('0007-g'))
    ctx.emit('devflow/stage-changed', card, 'designing')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(started).toHaveLength(1) // disposed drivers dispatch nothing
  })
})
