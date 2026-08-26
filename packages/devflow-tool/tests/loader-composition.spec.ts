// REAL-composition proof: a cordis.yml booted through the actual Loader mounts
// the filesystem provider and the devflow tools, and the model-facing calls
// read journal-derived state end to end — including the fail-loud journal path
// surfacing as a tool error and provider misconfiguration failing the boot.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as ToolDevflow from '@zhchxiao123/dsh-devflow-tool'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function writeCard(devflowRoot: string, id: string, cardFile: string, journal: string): Promise<void> {
  const dir = join(devflowRoot, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), cardFile)
  await writeFile(join(dir, 'journal.jsonl'), journal)
}

async function boot(rootLine: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devflow-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    '  config:',
    rootLine,
    "- name: '@zhchxiao123/dsh-devflow-tool'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore],
    ['@zhchxiao123/dsh-devflow-tool', ToolDevflow],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function agent(ctx: Context, name: string, cwd?: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, undefined, cwd === undefined
    ? undefined
    : { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd })
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

async function execute(
  ctx: Context,
  name: string,
  args: object,
  owner?: Agent,
): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`devflow-${name}-${JSON.stringify(args).length}`),
    name,
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
  return { isError: result.isError, text: resultText(result) }
}

describe('tool-devflow real Loader composition through cordis.yml', () => {
  it('lists and shows journal-derived card state end to end', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0042-retry-backoff',
        // The projection deliberately drifts (stage: draft); the journal must win.
        '---\ntitle: Add retry backoff jitter\nstage: draft\nstageRevision: 1\n---\n\n## Requirement\nFull jitter.\n',
        [
          '{"rev":1,"at":"t1","type":"created","by":{"kind":"human","name":"byclaw"}}',
          '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing","by":{"kind":"agent","session":"s1"}}',
        ].join('\n') + '\n',
      )
      await writeCard(
        devflowRoot,
        '0043-blocked-card',
        '---\ntitle: Blocked work\n---\n\nWaiting.\n',
        [
          '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
          '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"blocked","reason":"external dependency"}',
        ].join('\n') + '\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)

      const schemas = ctx.tools.schemas().map(schema => schema.name)
      expect(schemas).toContain('devflow_list')
      expect(schemas).toContain('devflow_show')

      const list = await execute(ctx, 'devflow_list', {})
      expect(list.isError).toBe(false)
      expect(list.text).toContain('0042-retry-backoff [designing] Add retry backoff jitter')

      const filtered = await execute(ctx, 'devflow_list', { stage: 'done' })
      expect(filtered.text).toBe('No devflow cards.')

      const blocked = await execute(ctx, 'devflow_show', { id: '0043-blocked-card' })
      expect(blocked.isError).toBe(false)
      expect(blocked.text).toContain('[blocked] Blocked work')

      const show = await execute(ctx, 'devflow_show', { id: '0042-retry-backoff' })
      expect(show.isError).toBe(false)
      expect(show.text).toContain('[designing] Add retry backoff jitter (rev 2)')
      expect(show.text).toContain('Full jitter.')

      // Render intent is part of the tool design: generic read cards, pure of args.
      expect(ctx.tools.get('devflow_list')?.presentCall?.({})).toEqual({
        card: 'generic',
        title: 'List devflow cards',
        kind: 'read',
      })
      expect(ctx.tools.get('devflow_list')?.presentCall?.({ stage: 'designing' })).toEqual({
        card: 'generic',
        title: 'List devflow cards at designing',
        kind: 'read',
      })
      expect(ctx.tools.get('devflow_show')?.presentCall?.({ id: '0042-retry-backoff' })).toEqual({
        card: 'generic',
        title: 'Show devflow card 0042-retry-backoff',
        kind: 'read',
        rawInput: '0042-retry-backoff',
      })
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('surfaces a fail-loud journal as a tool error naming file and line', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0001-broken',
        '---\ntitle: Broken journal\n---\nbody\n',
        '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}\n{"rev":2,"at":"t2","type":"renamed"}\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const show = await execute(ctx, 'devflow_show', { id: '0001-broken' })
      expect(show.isError).toBe(true)
      expect(show.text).toContain('journal.jsonl:2')
      expect(show.text).toContain('"type" must be created, transition, artifact, or claim-expired')
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('fails loading when the provider root is not a string', async () => {
    await expect(boot('    root: 7')).rejects.toThrow(/root/)
  }, 30_000)

  it('takes a ready card and transitions it end to end, recording session events', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0044-ready-card',
        '---\ntitle: Ready work\nstage: ready\nstageRevision: 3\n---\n\nDo it.\n',
        [
          '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
          '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
          '{"rev":3,"at":"t3","type":"transition","from":"designing","to":"ready"}',
        ].join('\n') + '\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const owner = agent(ctx, 'devflow-loader-agent')

      const take = await execute(ctx, 'devflow_take', { id: '0044-ready-card', expectedRevision: 3 }, owner)
      expect(take.isError).toBe(false)
      expect(take.text).toContain('moved ready -> developing (rev 4)')
      await expect(readFile(join(devflowRoot, 'tasks', '0044-ready-card', 'claim.json'), 'utf8'))
        .resolves.toContain('"kind": "agent"')

      // A second agent cannot take the claimed card; the failure has no side effects.
      const rival = agent(ctx, 'devflow-loader-rival')
      const rivalTake = await execute(ctx, 'devflow_take', { id: '0044-ready-card', expectedRevision: 4 }, rival)
      expect(rivalTake.isError).toBe(true)
      expect(rivalTake.text).toContain('already claimed')

      const moveOn = await execute(
        ctx,
        'devflow_transition',
        { id: '0044-ready-card', to: 'reviewing', expectedRevision: 4, reason: 'work finished' },
        owner,
      )
      expect(moveOn.isError).toBe(false)
      expect(moveOn.text).toContain('moved developing -> reviewing (rev 5)')

      const stale = await execute(
        ctx,
        'devflow_transition',
        { id: '0044-ready-card', to: 'testing', expectedRevision: 4 },
        owner,
      )
      expect(stale.isError).toBe(true)
      expect(stale.text).toContain('at revision 5, not the expected 4')

      // Rework edges require a recorded reason; the rejection is the executor's.
      const bareRework = await execute(
        ctx,
        'devflow_transition',
        { id: '0044-ready-card', to: 'developing', expectedRevision: 5 },
        owner,
      )
      expect(bareRework.isError).toBe(true)
      expect(bareRework.text).toContain('requires a reason')

      const rework = await execute(
        ctx,
        'devflow_transition',
        { id: '0044-ready-card', to: 'developing', expectedRevision: 5, reason: 'review found gaps' },
        owner,
      )
      expect(rework.isError).toBe(false)

      const attach = await execute(
        ctx,
        'devflow_attach_artifact',
        { id: '0044-ready-card', path: 'artifacts/review.md', expectedRevision: 6 },
        owner,
      )
      expect(attach.isError).toBe(false)
      expect(attach.text).toContain('Registered artifacts/review.md on card 0044-ready-card at developing (rev 7)')

      const staleAttach = await execute(
        ctx,
        'devflow_attach_artifact',
        { id: '0044-ready-card', path: 'artifacts/dup.md', expectedRevision: 6 },
        owner,
      )
      expect(staleAttach.isError).toBe(true)
      expect(staleAttach.text).toContain('at revision 7, not the expected 6')
      expect(ctx.tools.get('devflow_attach_artifact')?.presentCall?.({ id: 'x', path: 'artifacts/a.md', expectedRevision: 2 })).toEqual({
        card: 'generic',
        title: 'Register artifact artifacts/a.md on x',
        kind: 'edit',
        rawInput: { id: 'x', path: 'artifacts/a.md' },
      })
      const journalText = await readFile(join(devflowRoot, 'tasks', '0044-ready-card', 'journal.jsonl'), 'utf8')
      expect(journalText).toContain('"type":"artifact"')
      expect(journalText).toContain('review found gaps')
      const shown = await execute(ctx, 'devflow_show', { id: '0044-ready-card' }, owner)
      expect(shown.isError).toBe(false)

      // The move's authority is the journal asserted above, and the loop
      // already logs the call and its result. The session carries no
      // devflow-shaped copy of either — a trace with no reader.
      expect(owner.session.events.filter(event => event.type.startsWith('devflow/'))).toEqual([])

      // The journal is replayable authority: a fresh read agrees with the tools.
      const show = await execute(ctx, 'devflow_show', { id: '0044-ready-card' }, owner)
      expect(show.text).toContain('[developing] Ready work (rev 7)')

      // A take whose move is rejected releases the fresh lease before erroring.
      await writeCard(
        devflowRoot,
        '0046-blocked',
        '---\ntitle: Blocked take\n---\nbody\n',
        [
          '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
          '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"blocked"}',
        ].join('\n') + '\n',
      )
      const notReady = await execute(ctx, 'devflow_take', { id: '0046-blocked', expectedRevision: 2 }, rival)
      expect(notReady.isError).toBe(true)
      expect(notReady.text).toContain('cannot move from "blocked" to "developing"')
      await expect(readFile(join(devflowRoot, 'tasks', '0046-blocked', 'claim.json'), 'utf8'))
        .rejects.toThrow(/ENOENT/)

      // Mutation render intent: generic edit cards, pure of args.
      expect(ctx.tools.get('devflow_transition')?.presentCall?.({ id: 'x', to: 'ready', expectedRevision: 2 })).toEqual({
        card: 'generic',
        title: 'Move devflow card x to ready',
        kind: 'edit',
        rawInput: { id: 'x', to: 'ready', expectedRevision: 2 },
      })
      expect(ctx.tools.get('devflow_take')?.presentCall?.({ id: 'x', expectedRevision: 2 })).toEqual({
        card: 'generic',
        title: 'Take devflow card x',
        kind: 'edit',
        rawInput: { id: 'x', expectedRevision: 2 },
      })
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('creates a card from chat input end to end', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const owner = agent(ctx, 'devflow-loader-creator')
      const created: string[] = []
      ctx.on('devflow/card-created', (card) => { created.push(card.id) })

      const schemas = ctx.tools.schemas().map(schema => schema.name)
      expect(schemas).toContain('devflow_create')

      const result = await execute(
        ctx,
        'devflow_create',
        { title: 'Add retry backoff', body: '## Requirement\nFull jitter.\n\n## Acceptance\n- [ ] jitter applied' },
        owner,
      )
      expect(result.isError).toBe(false)
      expect(result.text).toBe('Created card 0001-add-retry-backoff [draft] Add retry backoff.')
      expect(created).toEqual(['0001-add-retry-backoff'])

      const journal = await readFile(join(devflowRoot, 'tasks', '0001-add-retry-backoff', 'journal.jsonl'), 'utf8')
      expect(JSON.parse(journal.trim())).toMatchObject({
        rev: 1,
        type: 'created',
        by: { kind: 'agent', session: 'devflow-loader-creator' },
      })
      const projected = await readFile(join(devflowRoot, 'tasks', '0001-add-retry-backoff', 'card.md'), 'utf8')
      expect(projected).toContain('title: Add retry backoff')
      expect(projected).toContain('- [ ] jitter applied')

      // As with a move, the creation leaves no devflow-shaped session record.
      expect(owner.session.events.filter(event => event.type.startsWith('devflow/'))).toEqual([])

      // The created card is immediately on the board the model reads.
      const list = await execute(ctx, 'devflow_list', {})
      expect(list.text).toContain('0001-add-retry-backoff [draft] Add retry backoff')

      // Domain rejections surface as tool errors with the stable message.
      const invalid = await execute(ctx, 'devflow_create', { title: 'Bad slug', body: 'x', slug: 'Not Valid' }, owner)
      expect(invalid.isError).toBe(true)
      expect(invalid.text).toContain('lowercase letters, digits, and dashes')

      // A non-agent caller has no session to attribute the creation to.
      const anonymous = await execute(ctx, 'devflow_create', { title: 'Nobody', body: 'x' })
      expect(anonymous.isError).toBe(true)
      expect(anonymous.text).toContain('require an owning agent session')
      expect(created).toEqual(['0001-add-retry-backoff'])

      expect(ctx.tools.get('devflow_create')?.presentCall?.({ title: 'Add retry backoff', body: 'b' })).toEqual({
        card: 'generic',
        title: 'Create devflow card: Add retry backoff',
        kind: 'edit',
        rawInput: { title: 'Add retry backoff' },
      })
      expect(ctx.tools.get('devflow_create')?.presentCall?.({ title: 'T', body: 'b', slug: 'custom' })).toEqual({
        card: 'generic',
        title: 'Create devflow card: T',
        kind: 'edit',
        rawInput: { title: 'T', slug: 'custom' },
      })
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('decomposes a big requirement into child cards end to end', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const owner = agent(ctx, 'devflow-loader-splitter')

      const parent = await execute(ctx, 'devflow_create', { title: 'Big requirement', body: 'Whole picture.' }, owner)
      expect(parent.isError).toBe(false)
      const first = await execute(
        ctx,
        'devflow_create',
        { title: 'First slice', body: 'Slice one.', parent: '0001-big-requirement' },
        owner,
      )
      expect(first.isError).toBe(false)
      expect(first.text).toBe('Created card 0002-first-slice [draft] First slice.')
      await execute(ctx, 'devflow_create', { title: 'Second slice', body: 'Slice two.', parent: '0001-big-requirement' }, owner)

      // The board names each child's parent, so the model never has to guess.
      const list = await execute(ctx, 'devflow_list', {})
      expect(list.text).toContain('0002-first-slice [draft] First slice (part of 0001-big-requirement)')
      expect(list.text).toContain('0001-big-requirement [draft] Big requirement\n')

      const children = await execute(ctx, 'devflow_list', { parent: '0001-big-requirement' })
      expect(children.text).toContain('0002-first-slice')
      expect(children.text).toContain('0003-second-slice')
      expect(children.text).not.toContain('0001-big-requirement [')

      // The parent card lists its breakdown; a child backlinks to the parent,
      // so a child-only worker can pull the whole picture itself.
      const shownParent = await execute(ctx, 'devflow_show', { id: '0001-big-requirement' })
      expect(shownParent.text).toContain('sub-requirements:')
      expect(shownParent.text).toContain('0002-first-slice [draft] First slice')
      expect(shownParent.text).toContain('0003-second-slice [draft] Second slice')

      const shownChild = await execute(ctx, 'devflow_show', { id: '0002-first-slice' })
      expect(shownChild.text).toContain('part of 0001-big-requirement — Big requirement')
      expect(shownChild.text).not.toContain('sub-requirements:')

      // The three illegal parents surface as tool errors with stable messages.
      const nested = await execute(ctx, 'devflow_create', { title: 'Too deep', body: 'x', parent: '0002-first-slice' }, owner)
      expect(nested.isError).toBe(true)
      expect(nested.text).toContain('one level deep')
      const unknown = await execute(ctx, 'devflow_create', { title: 'Nowhere', body: 'x', parent: '0099-ghost' }, owner)
      expect(unknown.isError).toBe(true)
      expect(unknown.text).toContain('no card 0099-ghost')

      // A child outliving its parent (archived first) keeps the bare backlink.
      await writeCard(
        devflowRoot,
        '0009-orphan',
        '---\ntitle: Orphan slice\n---\n\nStill open.\n',
        '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"},"parent":"0099-ghost"}\n',
      )
      const orphan = await execute(ctx, 'devflow_show', { id: '0009-orphan' })
      expect(orphan.isError).toBe(false)
      expect(orphan.text).toContain('part of 0099-ghost\n')

      expect(ctx.tools.get('devflow_list')?.presentCall?.({ parent: '0001-big-requirement' })).toEqual({
        card: 'generic',
        title: 'List devflow cards under 0001-big-requirement',
        kind: 'read',
      })

      expect(ctx.tools.get('devflow_create')?.presentCall?.({
        title: 'First slice',
        body: 'b',
        parent: '0001-big-requirement',
      })).toEqual({
        card: 'generic',
        title: 'Create devflow card: First slice',
        kind: 'edit',
        rawInput: { title: 'First slice', parent: '0001-big-requirement' },
      })
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('scopes every tool to the calling session\'s workspace devflow root', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'dsh-devflow-ws-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'dsh-devflow-ws-b-'))
    const configuredRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        configuredRoot,
        '0001-default-card',
        '---\ntitle: Default root card\n---\nbody\n',
        '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(configuredRoot)}`)
      const inA = agent(ctx, 'devflow-ws-a', workspaceA)
      const inB = agent(ctx, 'devflow-ws-b', workspaceB)
      const rootless = agent(ctx, 'devflow-rootless')

      // Creation lands in the caller's workspace, not the configured root.
      const created = await execute(ctx, 'devflow_create', { title: 'A-side card', body: 'A.' }, inA)
      expect(created.isError).toBe(false)
      await expect(readFile(join(workspaceA, '.devflow', 'tasks', '0001-a-side-card', 'journal.jsonl'), 'utf8'))
        .resolves.toContain('"type":"created"')

      // Each session sees exactly its workspace's board.
      const listA = await execute(ctx, 'devflow_list', {}, inA)
      expect(listA.text).toContain('0001-a-side-card')
      expect(listA.text).not.toContain('0001-default-card')
      const listB = await execute(ctx, 'devflow_list', {}, inB)
      expect(listB.text).toBe('No devflow cards.')

      // A caller without a session cwd falls back to the configured root.
      const listDefault = await execute(ctx, 'devflow_list', {}, rootless)
      expect(listDefault.text).toContain('0001-default-card')

      // Reads, moves, takes, and artifacts follow the same derivation.
      const shown = await execute(ctx, 'devflow_show', { id: '0001-a-side-card' }, inA)
      expect(shown.isError).toBe(false)
      const missing = await execute(ctx, 'devflow_show', { id: '0001-a-side-card' }, inB)
      expect(missing.isError).toBe(true)
      const moved = await execute(ctx, 'devflow_transition', { id: '0001-a-side-card', to: 'designing', expectedRevision: 1 }, inA)
      expect(moved.isError).toBe(false)
      const attach = await execute(ctx, 'devflow_attach_artifact', { id: '0001-a-side-card', path: 'artifacts/a.md', expectedRevision: 2 }, inA)
      expect(attach.isError).toBe(false)
      const journal = await readFile(join(workspaceA, '.devflow', 'tasks', '0001-a-side-card', 'journal.jsonl'), 'utf8')
      expect(journal.trim().split('\n')).toHaveLength(3)

      const readied = await execute(ctx, 'devflow_transition', { id: '0001-a-side-card', to: 'ready', expectedRevision: 3 }, inA)
      expect(readied.isError).toBe(false)
      const taken = await execute(ctx, 'devflow_take', { id: '0001-a-side-card', expectedRevision: 4 }, inA)
      expect(taken.isError).toBe(false)
      // The take's lease lives in the caller's workspace root.
      await expect(readFile(join(workspaceA, '.devflow', 'tasks', '0001-a-side-card', 'claim.json'), 'utf8'))
        .resolves.toContain('"kind": "agent"')
    } finally {
      await rm(workspaceA, { recursive: true, force: true })
      await rm(workspaceB, { recursive: true, force: true })
      await rm(configuredRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects a non-agent mutation without touching the card', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0045-untouched',
        '---\ntitle: Untouched\n---\nbody\n',
        '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const result = await execute(ctx, 'devflow_transition', { id: '0045-untouched', to: 'designing', expectedRevision: 1 })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('require an owning agent session')
      const journal = await readFile(join(devflowRoot, 'tasks', '0045-untouched', 'journal.jsonl'), 'utf8')
      expect(journal.trim().split('\n')).toHaveLength(1)
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
