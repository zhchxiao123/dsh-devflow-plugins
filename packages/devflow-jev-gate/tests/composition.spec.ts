// REAL-composition proof: with the gate loaded through the Loader next to the
// real judgement service, a warn edge records jev checks in the transition
// journal and always lands — even when the judgement hangs past its deadline —
// while an enforce edge vetoes on its configured condition with the numbers
// that triggered it; unconfigured edges and disposed fibers stay untouched.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionRegistry from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor, DevflowCardId as CardId, DevflowJournalEntry, TransitionResult } from '@zhchxiao123/dsh-devflow'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import { DevflowJev } from '@zhchxiao123/dsh-devflow-jev'
import * as DevflowJevPlugin from '@zhchxiao123/dsh-devflow-jev'
import { JevRuntime } from '@zhchxiao123/dsh-jev'
import type { JevRequest, JevResponse, Answer } from '@zhchxiao123/dsh-jev'
import * as DevflowJevGate from '../src/index.ts'

const HUMAN: DevActor = { kind: 'human', name: 'byclaw' }

/** Answers whatever the rubric asks; the release posture is scripted per scenario. */
class FixtureJev extends JevRuntime {
  static behavior: 'ok' | 'blocked-release' | 'hang' = 'ok'
  protected perform(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    if (FixtureJev.behavior === 'hang') {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new Error('cancelled')); return }
        signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      })
    }
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 }
      else if (question.type === 'score') {
        answers[id] = { type: 'score', score: 1, probabilities: [0, 1, ...Array.from({ length: question.criteria.length - 2 }, () => 0)], confidence: 0.9 }
      } else if (id === 'releaseDecision' && FixtureJev.behavior === 'blocked-release') {
        answers[id] = { type: 'choice', choice: 'ready', probabilities: { ready: 0.4, conditional: 0, blocked: 0.35, unavailable: 0.25 }, confidence: 0.3 }
      } else {
        const [first] = Object.keys(question.criteria)
        answers[id] = { type: 'choice', choice: first ?? '', probabilities: { [first ?? '']: 1 }, confidence: 1 }
      }
    }
    return Promise.resolve({ model: 'fixture', answers })
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  FixtureJev.behavior = 'ok'
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const EDGES = [
  'draft->designing', 'designing->ready', 'ready->developing', 'developing->reviewing', 'reviewing->testing',
] as const

/** A journal walked along the legal edges up to the named location. */
function journeyTo(location: 'developing' | 'testing'): string[] {
  const lines = ['{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}']
  for (const edge of EDGES.slice(0, location === 'developing' ? 3 : EDGES.length)) {
    const [from, to] = edge.split('->')
    lines.push(`{"rev":${String(lines.length + 1)},"at":"t","type":"transition","from":"${from!}","to":"${to!}"}`)
  }
  return lines
}

async function writeCard(id: string, journalLines: string[]): Promise<void> {
  const dir = join(root!, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${id}\n---\n\nBody of ${id}.\n`)
  await writeFile(join(dir, 'journal.jsonl'), journalLines.join('\n') + '\n')
}

async function boot(gateConfig: unknown): Promise<Context> {
  const configPath = join(root!, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    '- name: fixture-jev',
    "- name: '@zhchxiao123/dsh-devflow-jev'",
    "- name: '@zhchxiao123/dsh-devflow-jev-gate'",
    '  config:',
    JSON.stringify(gateConfig, null, 2).split('\n').map(line => `    ${line}`).join('\n'),
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore],
    ['fixture-jev', FixtureJev],
    ['@zhchxiao123/dsh-devflow-jev', DevflowJevPlugin],
    ['@zhchxiao123/dsh-devflow-jev-gate', DevflowJevGate],
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

function move(ctx: Context, id: CardId, to: string, expectedRevision: number): Promise<TransitionResult> {
  return ctx.devflow.transition(ctx.devflow.resolve({ id, to, expectedRevision, by: HUMAN } as Parameters<typeof ctx.devflow.resolve>[0]))
}

async function lastEntry(ctx: Context, id: CardId): Promise<DevflowJournalEntry> {
  const history = await ctx.devflow.history(id)
  return history[history.length - 1] as DevflowJournalEntry
}

describe('devflow-jev-gate real Loader composition', () => {
  it('records warn checks in the journal, survives a hanging judgement, and vetoes only on the enforce condition', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-jev-gate-'))
    await writeCard('0001-warned', journeyTo('developing'))
    await writeCard('0002-plain', ['{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}'])
    await writeCard('0003-release', journeyTo('testing'))
    await writeCard('0004-hung', journeyTo('developing'))
    const ctx = await boot({ edges: [
      { edge: 'developing->reviewing', kinds: ['implementation-risk'], mode: 'warn', timeoutMs: 3000 },
      { edge: 'testing->done', kinds: ['release-readiness'], mode: 'enforce', timeoutMs: 3000, failClosed: false, veto: { releaseBlockedMass: 0.5 } },
    ] })

    // The warn edge lands and the journal carries the judgement, traceable to its evaluation.
    expect(await move(ctx, DevflowCardId('0001-warned'), 'reviewing', 4)).toMatchObject({ ok: true })
    const warned = await lastEntry(ctx, DevflowCardId('0001-warned'))
    if (warned.type !== 'transition') throw new Error('expected a transition entry')
    const summary = warned.gate?.checks?.find(check => check.by.kind === 'command' && check.by.name === 'devflow-jev-gate')?.summary
    expect(summary).toMatch(/^jev implementation-risk \[[0-9a-f-]+\]: /)

    // An unconfigured edge is not the gate's business: no judgement checks appear.
    expect(await move(ctx, DevflowCardId('0002-plain'), 'designing', 1)).toMatchObject({ ok: true })
    const plain = await lastEntry(ctx, DevflowCardId('0002-plain'))
    if (plain.type !== 'transition') throw new Error('expected a transition entry')
    expect(plain.gate?.checks?.some(check => check.by.name === 'devflow-jev-gate') ?? false).toBe(false)

    // The enforce edge refuses a wavering release with the numbers, and a veto commits nothing.
    FixtureJev.behavior = 'blocked-release'
    const vetoed = await move(ctx, DevflowCardId('0003-release'), 'done', 6)
    expect(vetoed).toMatchObject({ ok: false, code: 'vetoed' })
    if (vetoed.ok) throw new Error('expected a veto')
    expect(vetoed.message).toContain('P(blocked)+P(unavailable)=0.60 ≥ 0.50')
    expect((await ctx.devflow.read(DevflowCardId('0003-release'))).stageRevision).toBe(6)

    // The same move lands once the release judgement settles.
    FixtureJev.behavior = 'ok'
    expect(await move(ctx, DevflowCardId('0003-release'), 'done', 6)).toMatchObject({ ok: true })
    const released = await lastEntry(ctx, DevflowCardId('0003-release'))
    if (released.type !== 'transition') throw new Error('expected a transition entry')
    expect(released.gate?.checks?.some(check => check.summary?.startsWith('jev release-readiness ['))).toBe(true)

    // A judgement that outlives its deadline silences itself; a warn edge still lands.
    FixtureJev.behavior = 'hang'
    expect(await move(ctx, DevflowCardId('0004-hung'), 'reviewing', 4)).toMatchObject({ ok: true })
    const hung = await lastEntry(ctx, DevflowCardId('0004-hung'))
    if (hung.type !== 'transition') throw new Error('expected a transition entry')
    expect(hung.gate?.checks?.find(check => check.by.name === 'devflow-jev-gate')?.summary)
      .toBe('jev implementation-risk: unavailable (timed out after 3000ms)')
  }, 30000)

  it('stops judging once its fiber is disposed (HMR safety)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-jev-gate-'))
    await writeCard('0001-warned', journeyTo('developing'))
    await writeCard('0004-hung', journeyTo('developing'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    await ctx.plugin(FixtureJev).await()
    await ctx.plugin(DevflowJev).await()
    const gate = ctx.plugin(DevflowJevGate, { edges: [{ edge: 'developing->reviewing', kinds: ['implementation-risk'], mode: 'warn', timeoutMs: 3000 }] })
    await gate.await()

    expect(await move(ctx, DevflowCardId('0001-warned'), 'reviewing', 4)).toMatchObject({ ok: true })
    const judged = await lastEntry(ctx, DevflowCardId('0001-warned'))
    if (judged.type !== 'transition') throw new Error('expected a transition entry')
    expect(judged.gate?.checks?.some(check => check.by.name === 'devflow-jev-gate')).toBe(true)

    await gate.dispose()

    expect(await move(ctx, DevflowCardId('0004-hung'), 'reviewing', 4)).toMatchObject({ ok: true })
    const unjudged = await lastEntry(ctx, DevflowCardId('0004-hung'))
    if (unjudged.type !== 'transition') throw new Error('expected a transition entry')
    expect(unjudged.gate?.checks?.some(check => check.by.name === 'devflow-jev-gate') ?? false).toBe(false)
  })
})
