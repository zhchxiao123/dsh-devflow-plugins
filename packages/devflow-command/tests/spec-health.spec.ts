// `/devflow spec` reports document health against a real provider: what is
// stale and WHICH anchor failed, what cannot be evaluated at all, and whether
// the scopes a deployment expects covered actually are. The report is derived
// from the seam's existing read face, so no store method exists for it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { emptyInbox } from '../../../tests/agent-double.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import FilesystemDevflowSpecStore, { encodeSpecFile } from '@zhchxiao123/dsh-devflow-spec-filesystem'
import * as CommandDevflow from '@zhchxiao123/dsh-devflow-command'

const SOURCE = 'export function apply(): void {}\n'

let root: string | undefined
let specRoot: string | undefined
let repoRoot: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, specRoot, repoRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  root = specRoot = repoRoot = undefined
})

function stubAgent(ctx: Context, name: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: root ?? '/tmp', isSeeded: false })
  const agent: Agent = {
    id: session.id, options: {}, session,
    inbox: emptyInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

/** Write one document straight to disk; the write path is not what is under test. */
async function seed(id: string, title: string, ...anchorFiles: string[]): Promise<void> {
  const path = join(specRoot!, `${id}.md`)
  await mkdir(join(path, '..'), { recursive: true })
  const anchors = anchorFiles.map((file, index) => ({
    id: `a${String(index)}`,
    kind: 'symbol' as const,
    file,
    symbol: 'apply',
  }))
  await writeFile(path, encodeSpecFile({
    title,
    updatedAt: '2026-09-02T00:00:00.000Z',
    anchors,
    body: `## Source of truth\n\nRests on ${anchors.map(anchor => `[[${anchor.id}]]`).join(' and ')}.\n`,
  }), 'utf8')
}

async function boot(options: { spec?: boolean; specScopes?: string[] } = {}): Promise<(input: string) => Promise<CommandResult>> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-devflow-spec-cmd-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  if (options.spec === true) {
    await ctx.plugin(FilesystemDevflowSpecStore, { root: specRoot, repoRoot }).await()
  }
  await ctx.plugin(CommandDevflow, options.specScopes === undefined ? {} : { specScopes: options.specScopes }).await()
  const agent = stubAgent(ctx, `spec-health-${Math.random()}`)
  return async (rawInput: string) => {
    const execution = await ctx.commands.execute(agent, `/devflow ${rawInput}`, [], new AbortController().signal)
    if (execution === undefined) throw new Error('the /devflow command did not resolve')
    return execution.result
  }
}

async function workspace(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devflow-spec-cmd-'))
  specRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-spec-docs-'))
  repoRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-spec-repo-'))
  await writeFile(join(repoRoot, 'probe.ts'), SOURCE, 'utf8')
}

describe('/devflow spec', () => {
  it('says the seam is absent rather than reporting an empty document set', async () => {
    const run = await boot()
    const result = await run('spec')
    expect(result.kind).toBe('error')
    expect(result).toHaveProperty('text', expect.stringContaining('not mounted here'))
  })

  it('rejects arguments it does not take', async () => {
    const run = await boot()
    const result = await run('spec everything')
    expect(result.kind).toBe('error')
    expect(result).toHaveProperty('text', expect.stringContaining('spec takes no arguments'))
  })

  it('counts the set, names each failing anchor, and closes with an instruction', async () => {
    await workspace()
    await seed('pkg-a/contract', 'Tool contract', 'probe.ts')
    // Two anchors, one still resolving: only the failure is worth a line.
    await seed('pkg-a/drift', 'Drifted note', 'probe.ts', 'removed.ts')
    await seed('pkg-b/opaque', 'Shell runbook', 'deploy.sh')
    const run = await boot({ spec: true })

    const result = await run('spec')

    expect(result.kind).toBe('success')
    const text = (result as { text: string }).text
    expect(text).toContain('3 document(s) — 1 fresh, 1 stale, 1 unevaluable')
    // The roll-up alone would send a reader to re-derive what this knows.
    expect(text).toContain('stale:')
    expect(text).toContain('  pkg-a/drift — Drifted note')
    expect(text).toContain('a1 (stale): removed.ts no longer exists')
    // The anchor that still holds is not reported as a problem.
    expect(text).not.toContain('a0 (stale)')
    expect(text).toContain('unevaluable:')
    expect(text).toContain('  pkg-b/opaque — Shell runbook')
    expect(text).toContain('a0 (unevaluable):')
    // A fresh document is counted, not listed: the report is about decay.
    expect(text).not.toContain('pkg-a/contract — Tool contract')
    expect(text).toContain('Merge, retire, or write what is missing.')
  })

  it('reports an unasked coverage question as unasked, not as full coverage', async () => {
    await workspace()
    await seed('pkg-a/contract', 'Tool contract', 'probe.ts')
    const run = await boot({ spec: true })

    const text = (await run('spec') as { text: string }).text

    expect(text).toContain('1 document(s) — 1 fresh, 0 stale, 0 unevaluable')
    expect(text).toContain('coverage: no expected scopes configured, so gaps are not reported')
    // Nothing is decayed and nothing was asked, so there is no instruction to give.
    expect(text).not.toContain('Merge, retire')
  })

  it('names the expected scopes that no document covers', async () => {
    await workspace()
    await seed('pkg-a/contract', 'Tool contract', 'probe.ts')
    const run = await boot({ spec: true, specScopes: ['pkg-a', 'pkg-b', 'pkg-c'] })

    const text = (await run('spec') as { text: string }).text

    expect(text).toContain('expected scopes with no document:')
    expect(text).toContain('  pkg-b')
    expect(text).toContain('  pkg-c')
    expect(text).not.toMatch(/^ {2}pkg-a$/m)
    expect(text).toContain('Merge, retire, or write what is missing.')
  })

  it('confirms full coverage when every expected scope is answered', async () => {
    await workspace()
    await seed('pkg-a/contract', 'Tool contract', 'probe.ts')
    await seed('pkg-b', 'Whole-package note', 'probe.ts')
    const run = await boot({ spec: true, specScopes: ['pkg-a', 'pkg-b'] })

    const text = (await run('spec') as { text: string }).text

    // An exact-id match counts as covered, not only a prefixed child.
    expect(text).toContain('coverage: every expected scope has at least one document (2 checked)')
    expect(text).not.toContain('Merge, retire')
  })

  it('reports an empty document set without inventing a problem', async () => {
    await workspace()
    const run = await boot({ spec: true })
    const text = (await run('spec') as { text: string }).text
    expect(text).toContain('0 document(s) — 0 fresh, 0 stale, 0 unevaluable')
  })

  it('applies its default scope list under direct application outside Loader normalization', async () => {
    await workspace()
    await seed('pkg-a/contract', 'Tool contract', 'probe.ts')
    root ??= await mkdtemp(join(tmpdir(), 'dsh-devflow-spec-cmd-'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    await ctx.plugin(FilesystemDevflowSpecStore, { root: specRoot, repoRoot }).await()
    // `apply` directly, so schemastery never fills the omitted field in.
    await ctx.plugin({
      inject: ['commands', 'devflow'],
      apply: (child: Context) => {
        CommandDevflow.apply(child, {})
      },
    }).await()
    const agent = stubAgent(ctx, 'spec-health-direct')
    const execution = await ctx.commands.execute(agent, '/devflow spec', [], new AbortController().signal)

    expect(execution?.result).toHaveProperty('text', expect.stringContaining('no expected scopes configured'))
  })

  it('offers the subcommand in the usage line', async () => {
    const run = await boot()
    const result = await run('nonsense')
    expect(result).toHaveProperty('text', expect.stringContaining('|spec]'))
  })
})
