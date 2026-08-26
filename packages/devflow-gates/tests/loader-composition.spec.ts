// REAL-composition proof: a cordis.yml booted through the actual Loader mounts
// the subprocess runtime, the local bash executor, the devflow store, and the
// gates plugin; gate commands really run through ctx.shell, a red command
// vetoes the move with its output in the reason, and a green gate commits.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as DevflowGates from '@zhchxiao123/dsh-devflow-gates'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor, TransitionResult } from '@zhchxiao123/dsh-devflow'

const HUMAN: DevActor = { kind: 'human', name: 'byclaw' }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function writeCard(devflowRoot: string, id: string): Promise<void> {
  const dir = join(devflowRoot, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${id}\n---\nbody\n`)
  await writeFile(join(dir, 'journal.jsonl'), [
    '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
    '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
    '{"rev":3,"at":"t3","type":"transition","from":"designing","to":"ready"}',
    '{"rev":4,"at":"t4","type":"transition","from":"ready","to":"developing"}',
  ].join('\n') + '\n')
}

async function boot(devflowRoot: string, gateCommand: string, approvals = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devflow-gates-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-bash-local'",
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    '  config:',
    `    root: ${JSON.stringify(devflowRoot)}`,
    "- name: '@zhchxiao123/dsh-devflow-gates'",
    '  config:',
    '    edges:',
    `      'developing->reviewing': [${JSON.stringify(gateCommand)}]`,
    ...approvals ? ['    approvals:', "      - 'developing->reviewing'"] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-bash-local', LocalBashExecutor],
    ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore],
    ['@zhchxiao123/dsh-devflow-gates', DevflowGates],
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

function move(ctx: Context, id: string): Promise<TransitionResult> {
  const store = ctx.get('devflow') as FilesystemDevflowStore
  return store.transition(store.resolve({
    id: DevflowCardId(id),
    to: 'reviewing',
    expectedRevision: 4,
    by: HUMAN,
  }))
}

describe('devflow-gates real Loader composition with real bash', () => {
  it('a red gate command vetoes the move with its output; a green gate commits', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-gates-data-'))
    try {
      await writeCard(devflowRoot, '0001-gated')
      const failing = await boot(devflowRoot, 'echo failing-check >&2; exit 1')
      const vetoed = await move(failing, '0001-gated')
      expect(vetoed).toMatchObject({ ok: false, code: 'vetoed' })
      expect((vetoed as { message: string }).message).toContain('failing-check')
      const journal = await readFile(join(devflowRoot, 'tasks', '0001-gated', 'journal.jsonl'), 'utf8')
      expect(journal.trim().split('\n')).toHaveLength(4)

      await context?.fiber.dispose()
      context = undefined
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = undefined

      const passing = await boot(devflowRoot, 'exit 0')
      const committed = await move(passing, '0001-gated')
      expect(committed.ok).toBe(true)
      const after = await readFile(join(devflowRoot, 'tasks', '0001-gated', 'journal.jsonl'), 'utf8')
      expect(after.trim().split('\n')).toHaveLength(5)
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('an approval edge in a headless composition parks the card blocked for a human', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-devflow-gates-data-'))
    try {
      await writeCard(devflowRoot, '0002-headless')
      const ctx = await boot(devflowRoot, 'exit 0', true)
      const vetoed = await move(ctx, '0002-headless')
      expect(vetoed).toMatchObject({ ok: false, code: 'vetoed' })
      expect((vetoed as { message: string }).message).toContain('parked blocked')
      const store = ctx.get('devflow') as FilesystemDevflowStore
      let card = await store.read(DevflowCardId('0002-headless'))
      for (let attempt = 0; attempt < 100 && card.stage !== 'blocked'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        card = await store.read(DevflowCardId('0002-headless'))
      }
      expect(card).toMatchObject({ stage: 'blocked', blockedFrom: 'developing' })
      const journal = await readFile(join(devflowRoot, 'tasks', '0002-headless', 'journal.jsonl'), 'utf8')
      expect(journal).toContain('awaiting human approval for developing->reviewing')
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
