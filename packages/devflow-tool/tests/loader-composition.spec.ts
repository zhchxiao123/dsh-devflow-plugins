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
import * as ArtifactGate from '@zhchxiao123/dsh-devflow-artifact-gate'
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

async function boot(rootLine: string, withArtifactContract = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devflow-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    '  config:',
    rootLine,
    ...withArtifactContract
      ? [
        "- name: '@zhchxiao123/dsh-devflow-artifact-gate'",
        '  config:',
        '    specs:',
        '      requirements-document:',
        '        frontmatter: [card, kind, title]',
        '        sections: [Requirements, Acceptance Criteria]',
        '      design-document:',
        '        frontmatter: [card, kind, title]',
        '        sections: [Approach, Interfaces, Risks]',
        '      development-report:',
        '        frontmatter: [card, kind, title]',
        '        sections: [Changes, Verification]',
        '    edges:',
        "      'draft->designing': [requirements-document]",
        "      'designing->ready': [design-document]",
        "      'developing->reviewing': [development-report]",
      ]
      : [],
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
    ['@zhchxiao123/dsh-devflow-artifact-gate', ArtifactGate],
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
  it('surfaces and refreshes artifact preflight across create, attach, and a successful stage move', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`, true)
      const owner = agent(ctx, 'devflow-artifact-flow')

      const created = await execute(ctx, 'devflow_create', {
        title: 'Artifact flow',
        slug: 'artifact-flow',
        body: 'Build the artifact flow.',
      }, owner)
      expect(created.isError).toBe(false)
      expect(created.text).toContain('Created card 0001-artifact-flow [draft] Artifact flow (rev 1).')
      expect(created.text).toContain('artifact requirements for draft -> designing:')
      expect(created.text).toContain('[missing] requirements-document')

      const malformed = await execute(ctx, 'devflow_attach_artifact', {
        id: '0001-artifact-flow',
        kind: 'requirements-document',
        content: '---\ncard: 0001-artifact-flow\nkind: requirements-document\ntitle: Artifact flow\n---\n',
        expectedRevision: 1,
      }, owner)
      expect(malformed.isError).toBe(false)
      expect(malformed.text).toContain('[malformed] requirements-document')
      expect(malformed.text).toContain('missing section "## Requirements"')
      expect(malformed.text).toContain('missing section "## Acceptance Criteria"')

      const satisfied = await execute(ctx, 'devflow_attach_artifact', {
        id: '0001-artifact-flow',
        kind: 'requirements-document',
        content: [
          '---',
          'card: 0001-artifact-flow',
          'kind: requirements-document',
          'title: Artifact flow',
          '---',
          '',
          '## Requirements',
          '',
          'Build it.',
          '',
          '## Acceptance Criteria',
          '',
          '- It works.',
          '',
        ].join('\n'),
        expectedRevision: 2,
      }, owner)
      expect(satisfied.isError).toBe(false)
      expect(satisfied.text).toContain('[satisfied] requirements-document')
      expect(satisfied.text).toContain('All required artifacts are satisfied.')

      const moved = await execute(ctx, 'devflow_transition', {
        id: '0001-artifact-flow',
        to: 'designing',
        expectedRevision: 3,
      }, owner)
      expect(moved.isError).toBe(false)
      expect(moved.text).toContain('Card 0001-artifact-flow moved draft -> designing (rev 4).')
      expect(moved.text).toContain('artifact requirements for designing -> ready:')
      expect(moved.text).toContain('[missing] design-document')

      const design = await execute(ctx, 'devflow_attach_artifact', {
        id: '0001-artifact-flow',
        kind: 'design-document',
        content: [
          '---',
          'card: 0001-artifact-flow',
          'kind: design-document',
          'title: Artifact flow design',
          '---',
          '',
          '## Approach',
          '',
          'Use one inspection seam.',
          '',
          '## Interfaces',
          '',
          'Expose inspectOutgoing.',
          '',
          '## Risks',
          '',
          'Keep outputs compatible.',
          '',
        ].join('\n'),
        expectedRevision: 4,
      }, owner)
      expect(design.text).toContain('[satisfied] design-document')

      const ready = await execute(ctx, 'devflow_transition', {
        id: '0001-artifact-flow',
        to: 'ready',
        expectedRevision: 5,
      }, owner)
      expect(ready.text).toBe('Card 0001-artifact-flow moved designing -> ready (rev 6).')

      const taken = await execute(ctx, 'devflow_take', {
        id: '0001-artifact-flow',
        expectedRevision: 6,
      }, owner)
      expect(taken.text).toContain('Card 0001-artifact-flow moved ready -> developing (rev 7).')
      expect(taken.text).toContain('artifact requirements for developing -> reviewing:')
      expect(taken.text).toContain('[missing] development-report')
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('shows the current edge artifact contract before a model attempts the transition', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0014-my-rust-app-init',
        '---\ntitle: Initialize Rust app\n---\n\nCreate a small Rust application.\n',
        [
          '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
          '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing","by":{"kind":"agent","session":"s1"}}',
        ].join('\n') + '\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`, true)

      const shown = await execute(ctx, 'devflow_show', { id: '0014-my-rust-app-init' })
      expect(shown.isError).toBe(false)
      expect(shown.text).toContain('artifact requirements for designing -> ready:')
      expect(shown.text).toContain('[missing] design-document')
      expect(shown.text).toContain('frontmatter: card, kind, title')
      expect(shown.text).toContain('sections: Approach, Interfaces, Risks')
      expect(shown.text).toContain('Do not call devflow_transition until every required artifact is satisfied.')
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('renders a satisfied artifact contract whose kind has no structural template fields', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0015-structural-marker',
        '---\ntitle: Structural marker\n---\n\nRecord the marker.\n',
        '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      ctx.provide('devflowArtifactContract', {
        inspectOutgoing: () => Promise.resolve([{
          from: 'draft',
          to: 'designing',
          requirements: [{
            kind: 'structural-marker',
            status: 'satisfied',
            spec: {},
            artifact: { path: 'artifacts/1-structural-marker.md', kind: 'structural-marker', rev: 1, stage: 'draft' },
            defects: [],
          }],
        }]),
      })

      const shown = await execute(ctx, 'devflow_show', { id: '0015-structural-marker' })

      expect(shown.isError).toBe(false)
      expect(shown.text).toContain('[satisfied] structural-marker')
      expect(shown.text).toContain('artifacts/1-structural-marker.md (rev 1)')
      expect(shown.text).not.toContain('frontmatter:')
      expect(shown.text).not.toContain('sections:')
      expect(shown.text).toContain('All required artifacts are satisfied.')
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

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
      expect(show.text).toContain('"type" must be created, transition, artifact, abandoned, or claim-expired')
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
      // A shortened pipeline is part of what the user is approving, so the
      // call preview has to carry it.
      expect(ctx.tools.get('devflow_create')?.presentCall?.({ title: 'T', body: 'b', serviceClass: 'emergency' })).toEqual({
        card: 'generic',
        title: 'Create devflow card: T',
        kind: 'edit',
        rawInput: { title: 'T', serviceClass: 'emergency' },
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

  // One card per class, driven the whole way through the real Loader: the
  // shortcut a class buys is an ordinary legal edge, and a class it lacks is an
  // ordinary illegal one.
  it('drives one card of each service class to done end to end', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const owner = agent(ctx, 'devflow-loader-classes')

      const emergency = await execute(
        ctx,
        'devflow_create',
        { title: 'Restore checkout', body: 'x', serviceClass: 'emergency' },
        owner,
      )
      expect(emergency.isError).toBe(false)
      expect(emergency.text).toContain('[draft]')
      expect((await execute(ctx, 'devflow_transition', { id: '0001-restore-checkout', to: 'developing', expectedRevision: 1 }, owner)).isError).toBe(false)
      expect((await execute(ctx, 'devflow_transition', { id: '0001-restore-checkout', to: 'done', expectedRevision: 2 }, owner)).isError).toBe(false)

      const express = await execute(
        ctx,
        'devflow_create',
        { title: 'Fix typo', body: 'x', serviceClass: 'express' },
        owner,
      )
      expect(express.isError).toBe(false)
      expect((await execute(ctx, 'devflow_transition', { id: '0002-fix-typo', to: 'developing', expectedRevision: 1 }, owner)).isError).toBe(false)
      expect((await execute(ctx, 'devflow_transition', { id: '0002-fix-typo', to: 'reviewing', expectedRevision: 2 }, owner)).isError).toBe(false)
      // `express` keeps review and skips independent verification.
      expect((await execute(ctx, 'devflow_transition', { id: '0002-fix-typo', to: 'done', expectedRevision: 3 }, owner)).isError).toBe(false)

      const standard = await execute(ctx, 'devflow_create', { title: 'Ordinary work', body: 'x' }, owner)
      expect(standard.isError).toBe(false)
      const refused = await execute(ctx, 'devflow_transition', { id: '0003-ordinary-work', to: 'developing', expectedRevision: 1 }, owner)
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('cannot move from "draft" to "developing"')

      // A shortened pipeline is marked on the board; an ordinary card is not.
      const list = await execute(ctx, 'devflow_list', {})
      expect(list.text).toContain('0002-fix-typo [done] <express>')
      expect(list.text).toContain('0003-ordinary-work [draft] Ordinary work')
      expect(list.text).not.toContain('<standard>')

      const shown = await execute(ctx, 'devflow_show', { id: '0001-restore-checkout' })
      expect(shown.text).toContain('<emergency>')
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  })

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

  it('registers store-written artifacts and reads the newest back by kind end to end', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0050-kinded',
        '---\ntitle: Kinded work\n---\n\nDo it.\n',
        [
          '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
          '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
        ].join('\n') + '\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const owner = agent(ctx, 'devflow-loader-kinds')
      expect(ctx.tools.schemas().map(schema => schema.name)).toContain('devflow_read_artifact')

      const attach = await execute(
        ctx,
        'devflow_attach_artifact',
        { id: '0050-kinded', kind: 'design-review', content: '# Review\n\nLooks right.\n', expectedRevision: 2 },
        owner,
      )
      expect(attach.isError).toBe(false)
      expect(attach.text).toBe('Registered artifacts/3-design-review.md [design-review] on card 0050-kinded at designing (rev 3).')
      await expect(readFile(join(devflowRoot, 'tasks', '0050-kinded', 'artifacts', '3-design-review.md'), 'utf8'))
        .resolves.toBe('# Review\n\nLooks right.\n')

      // The board's card view lists the registration with its kind, stage, and revision.
      const shown = await execute(ctx, 'devflow_show', { id: '0050-kinded' }, owner)
      expect(shown.isError).toBe(false)
      expect(shown.text).toContain('artifacts:\n  artifacts/3-design-review.md [design-review] (designing, rev 3)')

      const read = await execute(ctx, 'devflow_read_artifact', { id: '0050-kinded', kind: 'design-review' }, owner)
      expect(read.isError).toBe(false)
      expect(read.text).toBe('artifacts/3-design-review.md (designing, rev 3)\n\n# Review\n\nLooks right.\n')

      // Registrations are immutable: a second one of the same kind lands under
      // a new revision name, and the reader serves the newest.
      const again = await execute(
        ctx,
        'devflow_attach_artifact',
        { id: '0050-kinded', kind: 'design-review', content: 'Second pass.\n', expectedRevision: 3 },
        owner,
      )
      expect(again.isError).toBe(false)
      const newest = await execute(ctx, 'devflow_read_artifact', { id: '0050-kinded', kind: 'design-review' }, owner)
      expect(newest.text).toBe('artifacts/4-design-review.md (designing, rev 4)\n\nSecond pass.\n')

      // An unregistered kind is the stable no-artifact error.
      const missing = await execute(ctx, 'devflow_read_artifact', { id: '0050-kinded', kind: 'ghost' }, owner)
      expect(missing.isError).toBe(true)
      expect(missing.text).toContain('no-artifact: card 0050-kinded has no registered "ghost" artifact')

      // The seam's kind grammar surfaces as the stable tool error.
      const badKind = await execute(
        ctx,
        'devflow_attach_artifact',
        { id: '0050-kinded', kind: 'Not Valid', content: 'x', expectedRevision: 4 },
        owner,
      )
      expect(badKind.isError).toBe(true)
      expect(badKind.text).toContain('lowercase letters, digits, and dashes')

      // Render intent of the new form and the new read, pure of args.
      expect(ctx.tools.get('devflow_attach_artifact')?.presentCall?.({ id: 'x', kind: 'design', content: 'c', expectedRevision: 2 })).toEqual({
        card: 'generic',
        title: 'Register design artifact on x',
        kind: 'edit',
        rawInput: { id: 'x', kind: 'design' },
      })
      expect(ctx.tools.get('devflow_attach_artifact')?.presentCall?.({ id: 'x', expectedRevision: 2 })).toEqual({
        card: 'generic',
        title: 'Register a store-written artifact on x',
        kind: 'edit',
        rawInput: { id: 'x' },
      })
      expect(ctx.tools.get('devflow_read_artifact')?.presentCall?.({ id: 'x', kind: 'design' })).toEqual({
        card: 'generic',
        title: 'Read design artifact of devflow card x',
        kind: 'read',
        rawInput: { id: 'x', kind: 'design' },
      })
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects mixed and incomplete artifact registration forms before the seam is reached', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-data-'))
    try {
      await writeCard(
        devflowRoot,
        '0051-forms',
        '---\ntitle: Forms\n---\n\nbody\n',
        '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}\n',
      )
      const ctx = await boot(`    root: ${JSON.stringify(devflowRoot)}`)
      const owner = agent(ctx, 'devflow-loader-forms')

      const mixed = [
        { path: 'artifacts/a.md', kind: 'design' },
        { path: 'artifacts/a.md', content: 'c' },
      ]
      for (const form of mixed) {
        const result = await execute(ctx, 'devflow_attach_artifact', { id: '0051-forms', expectedRevision: 1, ...form }, owner)
        expect(result.isError).toBe(true)
        expect(result.text).toContain('never both forms at once')
      }
      const incomplete = [{}, { kind: 'design' }, { content: 'c' }]
      for (const form of incomplete) {
        const result = await execute(ctx, 'devflow_attach_artifact', { id: '0051-forms', expectedRevision: 1, ...form }, owner)
        expect(result.isError).toBe(true)
        expect(result.text).toContain('needs `path`')
      }
      // No rejected form reached the seam: the journal still carries only the creation.
      const journal = await readFile(join(devflowRoot, 'tasks', '0051-forms', 'journal.jsonl'), 'utf8')
      expect(journal.trim().split('\n')).toHaveLength(1)
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
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
