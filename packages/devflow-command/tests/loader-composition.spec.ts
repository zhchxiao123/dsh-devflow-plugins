// REAL-composition proof: a cordis.yml booted through the actual Loader mounts
// the session store, the command runtime, the agent registry, the devflow
// store, and the /devflow command; a dispatched command line really moves the
// card through the executor and journals the command actor.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as CommandDevflow from '@zhchxiao123/dsh-devflow-command'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(devflowRoot: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-command-devflow-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    '  config:',
    `    root: ${JSON.stringify(devflowRoot)}`,
    "- name: '@zhchxiao123/dsh-devflow-command'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore],
    ['@zhchxiao123/dsh-devflow-command', CommandDevflow],
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

function stubAgent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId('command-devflow-loader'))
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

describe('command-devflow real Loader composition', () => {
  it('dispatches /devflow through the command runtime and journals the command actor', async () => {
    const devflowRoot = await mkdtemp(join(tmpdir(), 'dsh-command-devflow-data-'))
    try {
      const dir = join(devflowRoot, 'tasks', '0001-loader')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'card.md'), '---\ntitle: Loader card\n---\nbody\n')
      await writeFile(join(dir, 'journal.jsonl'), '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}\n')

      const ctx = await boot(devflowRoot)
      const agent = stubAgent(ctx)
      const execution = await ctx.commands.execute(agent, '/devflow move 0001-loader designing kick off', [], new AbortController().signal)
      if (execution === undefined) throw new Error('the /devflow command did not resolve through the Loader composition')
      expect(execution.result.kind).toBe('success')
      expect(execution.result.text).toContain('moved draft -> designing (rev 2)')

      const journal = await readFile(join(dir, 'journal.jsonl'), 'utf8')
      expect(journal).toContain('"by":{"kind":"command","name":"devflow"}')
      expect(journal).toContain('kick off')
    } finally {
      await rm(devflowRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
