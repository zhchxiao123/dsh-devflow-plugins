// The /devflow intervention plane: board and card views, revision-checked
// moves through the ordinary executor (gates still decide), forced lease
// takeover with its journaled eviction, and done-card archiving — all with
// the command journal actor and no model turn.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor } from '@zhchxiao123/dsh-devflow'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as CommandDevflow from '@zhchxiao123/dsh-devflow-command'

const AGENT: DevActor = { kind: 'agent', session: 'ses-1' }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function writeCard(id: string, journalLines: string[]): Promise<void> {
  const dir = join(root!, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${id}\n---\n\nBody of ${id}.\n`)
  await writeFile(join(dir, 'journal.jsonl'), journalLines.join('\n') + '\n')
}

const CREATED = '{"rev":1,"at":"2026-08-25T00:00:00Z","type":"created","by":{"kind":"human"}}'
const DONE = [
  CREATED,
  '{"rev":2,"at":"2026-08-25T00:01:00Z","type":"transition","from":"draft","to":"designing"}',
  '{"rev":3,"at":"2026-08-25T00:02:00Z","type":"transition","from":"designing","to":"ready"}',
  '{"rev":4,"at":"2026-08-25T00:03:00Z","type":"transition","from":"ready","to":"developing"}',
  '{"rev":5,"at":"2026-08-25T00:04:00Z","type":"transition","from":"developing","to":"reviewing"}',
  '{"rev":6,"at":"2026-08-25T00:05:00Z","type":"transition","from":"reviewing","to":"testing"}',
  '{"rev":7,"at":"2026-07-01T00:06:00Z","type":"transition","from":"testing","to":"done"}',
]

function stubAgent(ctx: Context, name: string, cwd?: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, undefined, cwd === undefined
    ? undefined
    : { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd })
  const agent: Agent = {
    id: session.id, options: {}, session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

async function boot(): Promise<(input: string) => Promise<CommandResult>> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  await ctx.plugin(CommandDevflow).await()
  const agent = stubAgent(ctx, `command-devflow-${Math.random()}`)
  return async (rawInput: string) => {
    const line = rawInput.length === 0 ? '/devflow' : `/devflow ${rawInput}`
    const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
    if (execution === undefined) throw new Error(`the /devflow command did not resolve for ${JSON.stringify(line)}`)
    return execution.result
  }
}

describe('/devflow', () => {
  it('reports an empty board instead of an empty message', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
    const run = await boot()
    const board = await run('')
    expect(board.kind).toBe('success')
    expect(board.text).toContain('No devflow cards.')
  })

  it('renders the board, one card, and usage errors', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
    await writeCard('0001-a', [
      CREATED,
      '{"rev":2,"at":"2026-08-25T00:01:00Z","type":"artifact","stage":"draft","path":"artifacts/design.md"}',
    ])
    const run = await boot()

    const board = await run('')
    expect(board.kind).toBe('success')
    expect(board.text).toContain('0001-a [draft] rev 2 — Card 0001-a')

    const shown = await run('show 0001-a')
    expect(shown.text).toContain('artifacts: artifacts/design.md')
    expect(shown.text).toContain('Body of 0001-a.')

    expect((await run('show')).kind).toBe('error')
    expect((await run('bogus')).kind).toBe('error')
    expect((await run('move 0001-a')).kind).toBe('error')
    expect((await run('move 0001-a parked')).kind).toBe('error')
    expect((await run('takeover a b')).kind).toBe('error')
    expect((await run('archive now')).kind).toBe('error')
  })

  it('renders the breakdown: children under their parent, orphans flat', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
    const child = (parent: string): string[] =>
      [`{"rev":1,"at":"2026-08-25T00:00:00Z","type":"created","by":{"kind":"human"},"parent":"${parent}"}`]
    await writeCard('0001-big', [CREATED])
    await writeCard('0002-slice-a', child('0001-big'))
    await writeCard('0003-slice-b', child('0001-big'))
    await writeCard('0004-standalone', [CREATED])
    // Its parent never made it into the active set: the backlink still shows.
    await writeCard('0005-orphan', child('0009-archived'))
    const run = await boot()

    const board = await run('')
    expect(board.text).toBe([
      '0001-big [draft] rev 1 — Card 0001-big',
      '  0002-slice-a [draft] rev 1 — Card 0002-slice-a',
      '  0003-slice-b [draft] rev 1 — Card 0003-slice-b',
      '0004-standalone [draft] rev 1 — Card 0004-standalone',
      '0005-orphan [draft] rev 1 — Card 0005-orphan (part of 0009-archived)',
    ].join('\n'))

    const parent = await run('show 0001-big')
    expect(parent.text).toContain('sub-requirements:\n  0002-slice-a [draft] rev 1 — Card 0002-slice-a')
    const slice = await run('show 0002-slice-a')
    expect(slice.text).toContain('part of 0001-big — Card 0001-big')
    expect(slice.text).not.toContain('sub-requirements:')
    // An unreadable parent degrades to the backlink id instead of failing the view.
    expect((await run('show 0005-orphan')).text).toContain('part of 0009-archived\n')
  })

  it('moves a card through the ordinary executor with the command actor', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
    await writeCard('0002-b', [CREATED])
    const run = await boot()

    const plain = await run('show 0002-b')
    expect(plain.text).not.toContain('artifacts:')

    const moved = await run('move 0002-b designing starting design')
    expect(moved.kind).toBe('success')
    expect(moved.text).toContain('moved draft -> designing (rev 2)')
    const journal = await readFile(join(root, 'tasks', '0002-b', 'journal.jsonl'), 'utf8')
    expect(journal).toContain('"by":{"kind":"command","name":"devflow"}')
    expect(journal).toContain('starting design')

    // The executor still enforces edges: an illegal jump reports the seam's message.
    const illegal = await run('move 0002-b done')
    expect(illegal.kind).toBe('error')
    expect(illegal.text).toContain('cannot move from "designing" to "done"')

    // Blocked recovery is an ordinary move back to the interrupted stage.
    expect((await run('move 0002-b blocked waiting')).kind).toBe('success')
    expect((await run('')).text).toContain('0002-b [blocked (from designing)]')
    const recovered = await run('move 0002-b designing resuming')
    expect(recovered.kind).toBe('success')
    expect(recovered.text).toContain('moved blocked -> designing')
  })

  it('takes over any lease with a journaled eviction that fails the stale holder CAS', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
    await writeCard('0003-c', [CREATED])
    const run = await boot()
    const store = context!.get('devflow') as FilesystemDevflowStore

    // A heartbeat from the future is treated as live, so even the forced
    // takeover reports the holder instead of evicting.
    const claimPath = join(root, 'tasks', '0003-c', 'claim.json')
    await writeFile(claimPath, JSON.stringify({
      owner: { kind: 'human', name: 'time-traveler' }, at: '2999-01-01T00:00:00Z', heartbeatAt: '2999-01-01T00:00:00Z',
    }, null, 2) + '\n')
    const refused = await run('takeover 0003-c')
    expect(refused.kind).toBe('error')
    expect(refused.text).toContain('already claimed')
    await rm(claimPath)

    const held = await store.claim(DevflowCardId('0003-c'), AGENT)
    expect(held.ok).toBe(true)
    const staleRevision = (await store.read(DevflowCardId('0003-c'))).stageRevision

    // Age the heartbeat by a tick: the takeover's staleness test is strict
    // (`age > 0`), so a same-millisecond heartbeat would still count as live.
    const live = JSON.parse(await readFile(claimPath, 'utf8')) as { owner: unknown; at: string }
    await writeFile(claimPath, JSON.stringify({ ...live, heartbeatAt: '2000-01-01T00:00:00Z' }, null, 2) + '\n')

    const taken = await run('takeover 0003-c')
    expect(taken.kind).toBe('success')
    const journal = await readFile(join(root, 'tasks', '0003-c', 'journal.jsonl'), 'utf8')
    expect(journal).toContain('"type":"claim-expired"')
    expect(journal).toContain('"previousOwner":{"kind":"agent"')

    // The evicted holder's next commit fails the revision check.
    const staleCommit = await store.transition(store.resolve({
      id: DevflowCardId('0003-c'), to: 'designing', expectedRevision: staleRevision, by: AGENT,
    }))
    expect(staleCommit).toMatchObject({ ok: false, code: 'revision-mismatch' })
  })

  it('scopes the whole command plane to the invoking session\'s workspace root', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
    await writeCard('0006-default', [CREATED])
    await boot()
    const ctx = context!
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-ws-'))
    try {
      const wsRoot = join(workspace, '.devflow')
      const dir = join(wsRoot, 'tasks', '0001-ws-card')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'card.md'), '---\ntitle: Workspace card\n---\n\nWs body.\n')
      await writeFile(join(dir, 'journal.jsonl'), CREATED + '\n')

      const scoped = stubAgent(ctx, `command-devflow-ws-${Math.random()}`, workspace)
      const run = async (rawInput: string): Promise<CommandResult> => {
        const line = rawInput.length === 0 ? '/devflow' : `/devflow ${rawInput}`
        const execution = await ctx.commands.execute(scoped, line, [], new AbortController().signal)
        if (execution === undefined) throw new Error('the /devflow command did not resolve')
        return execution.result
      }

      const board = await run('')
      expect(board.text).toContain('0001-ws-card')
      expect(board.text).not.toContain('0006-default')

      const moved = await run('move 0001-ws-card designing')
      expect(moved.kind).toBe('success')
      await expect(readFile(join(wsRoot, 'tasks', '0001-ws-card', 'journal.jsonl'), 'utf8'))
        .resolves.toContain('"to":"designing"')

      const taken = await run('takeover 0001-ws-card')
      expect(taken.kind).toBe('success')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('archives done cards by their last journal month and leaves the board', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-cmd-'))
    await writeCard('0004-d', DONE)
    await writeCard('0005-e', [CREATED])
    const run = await boot()

    const archived = await run('archive')
    expect(archived.kind).toBe('success')
    expect(archived.text).toContain('Archived 1 card(s): 0004-d.')
    // Keyed by the LAST entry's month.
    const moved = await readFile(join(root, 'archive', '2026-07', '0004-d', 'journal.jsonl'), 'utf8')
    expect(moved.trim().split('\n')).toHaveLength(7)
    const board = await run('')
    expect(board.text).toContain('0005-e')
    expect(board.text).not.toContain('0004-d')

    expect((await run('archive')).text).toBe('No done cards to archive.')
  })
})
