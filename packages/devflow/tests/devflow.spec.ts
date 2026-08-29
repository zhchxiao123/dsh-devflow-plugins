// Behavior of the seam vocabulary: journal decoding rejects malformed durable
// entries, replay derives current state and enforces stream invariants, and the
// abstract service registers/unregisters as `ctx.devflow` with the fiber.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DevflowStore, { decodeJournalEntry, DevflowCardId, foldJournal } from '@zhchxiao123/dsh-devflow'
import type {
  ArtifactRequest,
  ArtifactResult,
  CardFilter,
  ClaimHolder,
  ClaimResult,
  CreateRequest,
  CreateResult,
  CreateSpec,
  DevActor,
  DevCard,
  DevflowJournalEntry,
  TransitionRequest,
  TransitionResult,
  TransitionSpec,
} from '@zhchxiao123/dsh-devflow'

function entry(value: object): DevflowJournalEntry {
  return decodeJournalEntry(value)
}

const CREATED = { rev: 1, at: 't1', type: 'created', by: { kind: 'human', name: 'dev' } }

describe('decodeJournalEntry', () => {
  it('decodes the three entry kinds', () => {
    expect(entry(CREATED)).toEqual({ rev: 1, at: 't1', type: 'created', by: { kind: 'human', name: 'dev' } })
    expect(entry({ rev: 2, at: 't2', type: 'transition', from: 'draft', to: 'designing', by: { kind: 'agent', session: 's1' }, reason: 'start' }))
      .toMatchObject({ type: 'transition', from: 'draft', to: 'designing', reason: 'start' })
    expect(entry({ rev: 3, at: 't3', type: 'artifact', path: 'artifacts/design.md', stage: 'designing' }))
      .toMatchObject({ type: 'artifact', path: 'artifacts/design.md' })
    expect(entry({ rev: 4, at: 't4', type: 'transition', from: 'designing', to: 'ready', by: { kind: 'command', name: 'devflow' } }))
      .toMatchObject({ by: { kind: 'command', name: 'devflow' } })
    expect(entry({ rev: 5, at: 't5', type: 'transition', from: 'testing', to: 'done', gate: { approvedBy: { kind: 'human', name: 'byclaw' } } }))
      .toMatchObject({ gate: { approvedBy: { kind: 'human', name: 'byclaw' } } })
    expect(entry({ rev: 6, at: 't6', type: 'claim-expired', previousOwner: { kind: 'agent', session: 's1' }, by: { kind: 'command', name: 'lease-reaper' } }))
      .toMatchObject({ type: 'claim-expired', previousOwner: { kind: 'agent', session: 's1' } })
    expect(entry({ ...CREATED, parent: '0001-big' })).toMatchObject({ type: 'created', parent: '0001-big' })
  })

  it('folds the created entry\'s parent into the card state', () => {
    expect(foldJournal([
      entry({ ...CREATED, parent: '0001-big' }),
      entry({ rev: 2, at: 't', type: 'transition', from: 'draft', to: 'designing' }),
    ])).toEqual({ stage: 'designing', revision: 2, parent: '0001-big', artifacts: [] })
  })

  it.each([
    { label: 'non-object', value: 'x', message: 'must be a JSON object' },
    { label: 'bad rev', value: { ...CREATED, rev: 0 }, message: '"rev" must be a positive integer' },
    { label: 'bad at', value: { ...CREATED, at: '' }, message: '"at" must be a non-empty string' },
    { label: 'unknown type', value: { rev: 1, at: 't', type: 'renamed' }, message: '"type" must be created, transition, artifact, or claim-expired' },
    { label: 'bad from', value: { rev: 2, at: 't', type: 'transition', from: 'queued', to: 'draft' }, message: '"from" must be a stage' },
    { label: 'bad to', value: { rev: 2, at: 't', type: 'transition', from: 'draft', to: 'queued' }, message: '"to" must be a stage' },
    { label: 'bad actor kind', value: { rev: 1, at: 't', type: 'created', by: { kind: 'robot' } }, message: '"kind" must be human, agent, or command' },
    { label: 'non-object actor', value: { rev: 1, at: 't', type: 'created', by: 'me' }, message: 'actor must be a JSON object' },
    { label: 'empty optional string', value: { rev: 2, at: 't', type: 'transition', from: 'draft', to: 'designing', reason: '' }, message: '"reason" must be a non-empty string' },
    { label: 'bad artifact path', value: { rev: 2, at: 't', type: 'artifact', path: '', stage: 'designing' }, message: '"path" must be a non-empty string' },
    { label: 'bad artifact stage', value: { rev: 2, at: 't', type: 'artifact', path: 'a', stage: 'blocked' }, message: '"stage" must be one of' },
    { label: 'non-object gate', value: { rev: 2, at: 't', type: 'transition', from: 'draft', to: 'designing', gate: 'human' }, message: '"gate" must be a JSON object' },
    { label: 'gate without approvedBy', value: { rev: 2, at: 't', type: 'transition', from: 'draft', to: 'designing', gate: {} }, message: '"gate" requires "approvedBy"' },
    { label: 'claim-expired without previousOwner', value: { rev: 2, at: 't', type: 'claim-expired', by: { kind: 'human' } }, message: '"previousOwner" is required' },
    { label: 'empty parent', value: { ...CREATED, parent: '' }, message: '"parent" must be a non-empty card id' },
    { label: 'non-string parent', value: { ...CREATED, parent: 7 }, message: '"parent" must be a non-empty card id' },
  ])('rejects $label loudly', ({ value, message }) => {
    expect(() => entry(value as object)).toThrow(message)
  })
})

describe('foldJournal', () => {
  it('replays a full pipeline pass with blocked bypass and artifacts', () => {
    const state = foldJournal([
      entry(CREATED),
      entry({ rev: 2, at: 't', type: 'transition', from: 'draft', to: 'designing' }),
      entry({ rev: 3, at: 't', type: 'artifact', path: 'artifacts/design.md', stage: 'designing' }),
      entry({ rev: 4, at: 't', type: 'transition', from: 'designing', to: 'blocked' }),
      entry({ rev: 5, at: 't', type: 'transition', from: 'blocked', to: 'designing' }),
      entry({ rev: 6, at: 't', type: 'transition', from: 'designing', to: 'ready' }),
    ])
    expect(state).toEqual({ stage: 'ready', revision: 6, artifacts: ['artifacts/design.md'] })
  })

  it('advances the revision through a claim-expired entry without moving the card', () => {
    const state = foldJournal([
      entry(CREATED),
      entry({ rev: 2, at: 't', type: 'claim-expired', previousOwner: { kind: 'agent' }, by: { kind: 'command', name: 'lease-reaper' } }),
    ])
    expect(state).toEqual({ stage: 'draft', revision: 2, artifacts: [] })
  })

  it('keeps blockedFrom while blocked', () => {
    const state = foldJournal([
      entry(CREATED),
      entry({ rev: 2, at: 't', type: 'transition', from: 'draft', to: 'blocked' }),
    ])
    expect(state.stage).toBe('blocked')
    expect(state.blockedFrom).toBe('draft')
  })

  it.each([
    { label: 'empty journal', entries: [], message: 'journal is empty' },
    { label: 'first entry not created', entries: [{ rev: 1, at: 't', type: 'transition', from: 'draft', to: 'designing' }], message: 'entry 1 must be "created"' },
    { label: 'repeated created', entries: [CREATED, { rev: 2, at: 't', type: 'created', by: { kind: 'human' } }], message: 'repeats "created"' },
    { label: 'gap in revisions', entries: [CREATED, { rev: 3, at: 't', type: 'transition', from: 'draft', to: 'designing' }], message: 'revisions must be contiguous' },
    { label: 'wrong departure', entries: [CREATED, { rev: 2, at: 't', type: 'transition', from: 'ready', to: 'developing' }], message: 'departs from "ready" but the card is at "draft"' },
    { label: 'self transition', entries: [CREATED, { rev: 2, at: 't', type: 'transition', from: 'draft', to: 'draft' }], message: 'does not move the card' },
    {
      label: 'recovery to the wrong stage',
      entries: [
        CREATED,
        { rev: 2, at: 't', type: 'transition', from: 'draft', to: 'blocked' },
        { rev: 3, at: 't', type: 'transition', from: 'blocked', to: 'ready' },
      ],
      message: 'recovers to "ready" but the card blocked from "draft"',
    },
  ])('rejects $label', ({ entries, message }) => {
    expect(() => foldJournal(entries.map(value => entry(value)))).toThrow(message)
  })
})

class StubStore extends DevflowStore {
  readonly listedRoots: (string | undefined)[] = []

  list(_filter?: CardFilter, root?: string): Promise<DevCard[]> {
    this.listedRoots.push(root)
    return Promise.resolve([])
  }

  read(id: DevflowCardId): Promise<DevCard> {
    return Promise.reject(new Error(`no card ${id}`))
  }

  history(_id: DevflowCardId, _root?: string): Promise<DevflowJournalEntry[]> {
    return Promise.resolve([])
  }

  holder(_id: DevflowCardId, _root?: string): Promise<ClaimHolder | undefined> {
    return Promise.resolve(undefined)
  }

  resolve(request: TransitionRequest): TransitionSpec {
    return { ...request, root: request.root ?? '/stub', at: 'stub' }
  }

  resolveCreate(request: CreateRequest): CreateSpec {
    return { ...request, slug: request.slug ?? 'card', root: request.root ?? '/stub', at: 'stub' }
  }

  create(spec: CreateSpec): Promise<CreateResult> {
    return Promise.resolve({ ok: false, code: 'exists', message: `stub store cannot create "${spec.slug}"` })
  }

  transition(spec: TransitionSpec): Promise<TransitionResult> {
    return Promise.resolve({ ok: false, code: 'illegal-edge', message: `stub store cannot move ${spec.id}` })
  }

  claim(id: DevflowCardId, owner: DevActor): Promise<ClaimResult> {
    return Promise.resolve({ ok: false, holder: owner, message: `stub store cannot claim ${id}` })
  }

  attachArtifact(request: ArtifactRequest): Promise<ArtifactResult> {
    return Promise.resolve({ ok: false, code: 'illegal-edge', message: `stub store cannot attach to ${request.id}` })
  }

  archiveDone(): Promise<DevflowCardId[]> {
    return Promise.resolve([])
  }
}

describe('DevflowStore service registration', () => {
  it('registers as ctx.devflow and unregisters on fiber disposal', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(StubStore)
    await fiber.await()
    expect(ctx.get('devflow')).toBeInstanceOf(StubStore)
    await fiber.dispose()
    expect(ctx.get('devflow')).toBeUndefined()
  })

  it('rejects a second implementation in the same context', async () => {
    const ctx = new Context()
    await ctx.plugin(StubStore)
    class SecondStore extends StubStore {}
    await expect(ctx.plugin(SecondStore)).rejects.toThrow(/service "devflow" has been registered/)
  })

  it('serves the session-scoped reads through the abstract read face', async () => {
    const ctx = new Context()
    await ctx.plugin(StubStore).await()
    const store = ctx.get('devflow') as StubStore
    await expect(store.listForSession()).resolves.toEqual([])
    // No session id means the store's default root.
    expect(store.listedRoots).toEqual([undefined])
  })

  it('resolves a viewing session to its workspace devflow root on the session-scoped reads', async () => {
    const ctx = new Context()
    ctx.provide('sessions', {
      get: (id: string) => id === 'ses-live'
        ? { header: { cwd: '/workspaces/alpha' } }
        : undefined,
    } as never)
    ctx.provide('sessionPersistence', {
      inspect: (id: string) => {
        if (id === 'ses-cold') return Promise.resolve({ meta: { cwd: '/workspaces/beta' } })
        if (id === 'ses-rootless') return Promise.resolve({ meta: {} })
        return Promise.reject(new Error('absent'))
      },
    } as never)
    await ctx.plugin(StubStore).await()
    const store = ctx.get('devflow') as StubStore

    await store.listForSession(undefined, 'ses-live')
    await store.listForSession({ stage: 'draft' }, 'ses-cold')
    // A session without a cwd falls back to the default root.
    await store.listForSession(undefined, 'ses-rootless')
    expect(store.listedRoots).toEqual([
      join('/workspaces/alpha', '.devflow'),
      join('/workspaces/beta', '.devflow'),
      undefined,
    ])

    // An unknown session is a stable rejection, not a silent default-root read.
    await expect(store.listForSession(undefined, 'ses-unknown')).rejects.toThrow(/unknown session/)
  })

  it('rejects Remote session resolution when no session service is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(StubStore).await()
    const store = ctx.get('devflow') as StubStore
    await expect(store.listForSession(undefined, 'ses-any')).rejects.toThrow(/no session service/)
  })

  it('aggregates the Remote detail from the read, history, and holder faces with one resolved root', async () => {
    const seenRoots: (string | undefined)[] = []
    const holderValue: ClaimHolder = { owner: { kind: 'agent', session: 'ses-9' }, heartbeatAt: '2026-08-26T00:00:00Z' }
    class DetailStore extends StubStore {
      override read(id: DevflowCardId, root?: string): Promise<DevCard> {
        seenRoots.push(root)
        return Promise.resolve({
          id, root: root ?? '/default', title: 'T', stage: 'draft', stageRevision: 1,
          body: '', path: 'p', artifacts: [],
        })
      }

      override history(_id: DevflowCardId, root?: string): Promise<DevflowJournalEntry[]> {
        seenRoots.push(root)
        return Promise.resolve([{ rev: 1, at: 't1', type: 'created', by: { kind: 'human' } }])
      }

      override holder(_id: DevflowCardId, root?: string): Promise<ClaimHolder | undefined> {
        seenRoots.push(root)
        return Promise.resolve(holderValue)
      }
    }
    const ctx = new Context()
    ctx.provide('sessions', {
      get: () => ({ header: { cwd: '/workspaces/alpha' } }),
    } as never)
    await ctx.plugin(DetailStore).await()
    const store = ctx.get('devflow') as DetailStore

    const detail = await store.detailForSession(DevflowCardId('0001-a'), 'ses-live')
    expect(detail.card.title).toBe('T')
    expect(detail.entries).toHaveLength(1)
    expect(detail.holder).toEqual(holderValue)
    const root = join('/workspaces/alpha', '.devflow')
    expect(seenRoots).toEqual([root, root, root])

    // A transition landing between the card read and the journal read tears
    // the aggregate; the adapter re-reads once so both sides agree.
    let readCalls = 0
    class TearingStore extends StubStore {
      override read(id: DevflowCardId): Promise<DevCard> {
        readCalls += 1
        return Promise.resolve({
          id, root: '/r', title: 'T', stage: 'designing',
          stageRevision: readCalls === 1 ? 1 : 2,
          body: '', path: 'p', artifacts: [],
        })
      }

      override history(): Promise<DevflowJournalEntry[]> {
        return Promise.resolve([
          { rev: 1, at: 't1', type: 'created', by: { kind: 'human' } },
          { rev: 2, at: 't2', type: 'transition', from: 'draft', to: 'designing' },
        ])
      }
    }
    const torn = new Context()
    await torn.plugin(TearingStore).await()
    const settled = await (torn.get('devflow') as TearingStore).detailForSession(DevflowCardId('0001-a'))
    expect(readCalls).toBe(2)
    expect(settled.card.stageRevision).toBe(2)
    expect(settled.entries).toHaveLength(2)

    // Unclaimed cards omit the holder key entirely (exact wire JSON).
    class UnclaimedStore extends DetailStore {
      override holder(): Promise<ClaimHolder | undefined> {
        return Promise.resolve(undefined)
      }
    }
    const bare = new Context()
    await bare.plugin(UnclaimedStore).await()
    const unclaimed = await (bare.get('devflow') as UnclaimedStore).detailForSession(DevflowCardId('0001-a'))
    expect('holder' in unclaimed).toBe(false)
  })
})
