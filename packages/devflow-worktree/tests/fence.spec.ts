// The worktree fence against a real store and real git state: an
// undispatched card moves freely, a dispatched card moves from its worktree
// and from the repository's main working tree, every other checkout is
// vetoed with the dispatch named, a broken dispatch record fails closed, and
// disposing the plugin withdraws the fence.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor, TransitionResult } from '@zhchxiao123/dsh-devflow'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as Worktree from '@zhchxiao123/dsh-devflow-worktree'
import { injectFsAccessDenied, resetFsFaults, runWithFsFault } from '../../../tests/fs-fault'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) =>
      runWithFsFault('realpath', args[0], () => actual.realpath(...args)),
  }
})

const HUMAN: DevActor = { kind: 'human', name: 'byclaw' }
const CARD = '0001-a'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

let base: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
  resetFsFaults()
})

const READY = [
  '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
  '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
  '{"rev":3,"at":"t3","type":"transition","from":"designing","to":"ready"}',
]

const DISPATCHED = [
  ...READY,
  '{"rev":4,"at":"t4","type":"artifact","path":"artifacts/4-worktree.md","stage":"ready","kind":"worktree"}',
]

interface Fixture {
  main: string
  worktree: string
  store: FilesystemDevflowStore
  fence: { dispose(): Promise<void> }
}

async function writeCard(repo: string, journalLines: string[], dispatchBody?: string): Promise<void> {
  const dir = join(repo, '.devflow', 'tasks', CARD)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${CARD}\n---\nbody\n`)
  await writeFile(join(dir, 'journal.jsonl'), journalLines.join('\n') + '\n')
  if (dispatchBody !== undefined) {
    await mkdir(join(dir, 'artifacts'), { recursive: true })
    await writeFile(join(dir, 'artifacts', '4-worktree.md'), dispatchBody)
  }
}

function dispatchBody(worktree: string): string {
  return `---\nbranch: devflow/${CARD}\nbase: main\nworktree: ${worktree}\n---\nDispatched.\n`
}

/** A main checkout carrying the dispatched card, and its linked worktree. */
async function dispatchedFixture(options: { journal?: string[]; body?: string | false } = {}): Promise<Fixture> {
  base = await mkdtemp(join(tmpdir(), 'dsh-worktree-fence-'))
  const main = join(base, 'main')
  const worktree = join(base, 'wt')
  await mkdir(main)
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'config', 'user.email', 'fence@example.invalid')
  git(main, 'config', 'user.name', 'fence')
  const body = options.body === false ? undefined : options.body ?? dispatchBody(worktree)
  await writeCard(main, options.journal ?? DISPATCHED, body)
  git(main, 'add', '-A')
  git(main, 'commit', '-qm', 'dispatch')
  git(main, 'worktree', 'add', '-q', worktree, '-b', `devflow/${CARD}`)
  const booted = await boot(join(main, '.devflow'))
  return { main, worktree, ...booted }
}

async function boot(defaultRoot: string): Promise<{ store: FilesystemDevflowStore; fence: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FilesystemDevflowStore, { root: defaultRoot }).await()
  const fence = await ctx.plugin({
    inject: Worktree.inject,
    apply: (child: Context) => { Worktree.apply(child, {}) },
  })
  return { store: ctx.get('devflow') as FilesystemDevflowStore, fence }
}

function take(store: FilesystemDevflowStore, root: string, rev: number): Promise<TransitionResult> {
  return store.transition(store.resolve({
    id: DevflowCardId(CARD),
    to: 'developing',
    expectedRevision: rev,
    by: HUMAN,
    root,
  }))
}

describe('the worktree fence', () => {
  it('leaves an undispatched card free to move', async () => {
    const { main, store } = await dispatchedFixture({ journal: READY, body: false })
    expect(await take(store, join(main, '.devflow'), 3)).toMatchObject({ ok: true })
  })

  it('admits the dispatched card from its own worktree', async () => {
    const { worktree, store } = await dispatchedFixture()
    const root = join(worktree, '.devflow')
    expect(await take(store, root, 4)).toMatchObject({ ok: true })
    expect((await store.read(DevflowCardId(CARD), root)).stage).toBe('developing')
  })

  it('admits the dispatched card from the repository\'s main working tree', async () => {
    const { main, store } = await dispatchedFixture()
    expect(await take(store, join(main, '.devflow'), 4)).toMatchObject({ ok: true })
  })

  it('still admits main-side wrap-up after the worktree is removed', async () => {
    const { main, worktree, store } = await dispatchedFixture()
    await rm(worktree, { recursive: true, force: true })
    expect(await take(store, join(main, '.devflow'), 4)).toMatchObject({ ok: true })
  })

  it('vetoes a third checkout of the same repository, naming the dispatch', async () => {
    const { worktree, store } = await dispatchedFixture()
    const stray = join(base!, 'stray')
    await cp(worktree, stray, { recursive: true })
    const result = await take(store, join(stray, '.devflow'), 4)
    expect(result).toMatchObject({ ok: false, code: 'vetoed' })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain(`dispatched to worktree ${worktree}`)
    expect(result.message).toContain(stray)
  })

  it('vetoes a checkout outside any git repository', async () => {
    const { main, store } = await dispatchedFixture()
    const stray = join(base!, 'stray')
    await mkdir(stray)
    await cp(join(main, '.devflow'), join(stray, '.devflow'), { recursive: true })
    expect(await take(store, join(stray, '.devflow'), 4)).toMatchObject({ ok: false, code: 'vetoed' })
  })

  it('fails closed on a malformed dispatch record', async () => {
    const { main, store } = await dispatchedFixture({ body: '---\nbranch: devflow/0001-a\nbase: main\n---\nno worktree field\n' })
    const result = await take(store, join(main, '.devflow'), 4)
    expect(result).toMatchObject({ ok: false, code: 'vetoed' })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('malformed')
  })

  it('fails closed when the registered dispatch file is missing from disk', async () => {
    const { main, store } = await dispatchedFixture()
    const root = join(main, '.devflow')
    await rm(join(root, 'tasks', CARD, 'artifacts', '4-worktree.md'))
    const result = await take(store, root, 4)
    expect(result).toMatchObject({ ok: false, code: 'vetoed' })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('cannot be verified')
  })

  it('fails closed when the transition\'s own workspace cannot be canonicalized', async () => {
    const { main, store } = await dispatchedFixture()
    const root = join(main, '.devflow')
    injectFsAccessDenied({ operation: 'realpath', path: dirname(resolve(root)) })
    const result = await take(store, root, 4)
    expect(result).toMatchObject({ ok: false, code: 'vetoed' })
  })

  it('is withdrawn when the plugin fiber is disposed', async () => {
    const { worktree, store, fence } = await dispatchedFixture()
    const stray = join(base!, 'stray')
    await cp(worktree, stray, { recursive: true })
    // The store fiber stays up: the previously vetoed move now commits.
    expect(await take(store, join(stray, '.devflow'), 4)).toMatchObject({ ok: false, code: 'vetoed' })
    await fence.dispose()
    expect(await take(store, join(stray, '.devflow'), 4)).toMatchObject({ ok: true })
  })
})
