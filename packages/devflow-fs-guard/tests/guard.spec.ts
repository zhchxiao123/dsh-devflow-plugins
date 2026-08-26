// REAL-composition proof: with the guard loaded, an agent's file tools cannot
// mutate anything under a protected devflow state directory — the denial fires
// in the tool executor's intent waterfall — while the devflow tools' host-side
// executor keeps moving the same cards, so hardening costs no functionality.
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
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as ToolDevflow from '@zhchxiao123/dsh-devflow-tool'
import * as DevflowFsGuard from '@zhchxiao123/dsh-devflow-fs-guard'

let workspace: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function boot(configLines: string[] = []): Promise<Context> {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-devflow-guard-'))
  const configPath = join(workspace, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-tool-fs'",
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    "- name: '@zhchxiao123/dsh-devflow-tool'",
    "- name: '@zhchxiao123/dsh-devflow-fs-guard'",
    ...configLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(workspace).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-tool-fs', ToolFs],
    ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore],
    ['@zhchxiao123/dsh-devflow-tool', ToolDevflow],
    ['@zhchxiao123/dsh-devflow-fs-guard', DevflowFsGuard],
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

function agent(ctx: Context, name: string, cwd: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd })
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
  owner: Agent,
  name: string,
  args: object,
): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`guard-${name}-${JSON.stringify(args).length}`),
    name,
    arguments: args,
    agent: owner,
  })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  return { isError: result.isError, text }
}

async function seedCard(root: string, id: string): Promise<void> {
  const dir = join(root, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${id}\n---\n\nBody.\n`)
  await writeFile(join(dir, 'journal.jsonl'), '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}\n')
}

describe('devflow-fs-guard real Loader composition', () => {
  it('denies file-tool mutations under .devflow while the devflow executor keeps working', async () => {
    const ctx = await boot()
    const owner = agent(ctx, 'guard-agent', workspace!)
    const devflowRoot = join(workspace!, '.devflow')
    await seedCard(devflowRoot, '0001-guarded')
    const journalPath = join(devflowRoot, 'tasks', '0001-guarded', 'journal.jsonl')
    const journalBefore = await readFile(journalPath, 'utf8')

    // Forged history through the write tool is denied in the executor.
    const forged = await execute(ctx, owner, 'write', {
      file_path: journalPath,
      content: journalBefore + '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"done"}\n',
    })
    expect(forged.isError).toBe(true)
    expect(forged.text).toContain('devflow')
    await expect(readFile(journalPath, 'utf8')).resolves.toBe(journalBefore)

    // The projection and any other file under the state directory are equally protected.
    const projected = await execute(ctx, owner, 'edit', {
      file_path: join(devflowRoot, 'tasks', '0001-guarded', 'card.md'),
      old_string: 'Body.',
      new_string: 'Forged.',
    })
    expect(projected.isError).toBe(true)

    // Ordinary workspace code stays fully writable.
    const code = await execute(ctx, owner, 'write', { file_path: join(workspace!, 'src', 'app.ts'), content: 'export {}\n' })
    expect(code.isError).toBe(false)
    await expect(readFile(join(workspace!, 'src', 'app.ts'), 'utf8')).resolves.toBe('export {}\n')

    // The same card still moves through the devflow tools' host-side executor.
    const moved = await execute(ctx, owner, 'devflow_transition', {
      id: '0001-guarded', to: 'designing', expectedRevision: 1,
    })
    expect(moved.isError).toBe(false)
    await expect(readFile(journalPath, 'utf8')).resolves.toContain('"to":"designing"')

    // Chat creation writes host-side too, under the same active policy.
    const created = await execute(ctx, owner, 'devflow_create', { title: 'Guarded card', body: 'B.' })
    expect(created.isError).toBe(false)
  }, 30_000)

  it('honors configured directory names beyond the default', async () => {
    const ctx = await boot([
      '  config:',
      "    directories: ['.flowstate']",
    ])
    const owner = agent(ctx, 'guard-agent-custom', workspace!)
    await mkdir(join(workspace!, '.flowstate'), { recursive: true })

    const denied = await execute(ctx, owner, 'write', {
      file_path: join(workspace!, '.flowstate', 'journal.jsonl'),
      content: '{}\n',
    })
    expect(denied.isError).toBe(true)

    // The default name is no longer protected once the deployment overrides it.
    const allowed = await execute(ctx, owner, 'write', {
      file_path: join(workspace!, '.devflow', 'free.txt'),
      content: 'ok\n',
    })
    expect(allowed.isError).toBe(false)
  }, 30_000)

  it('defaults to protecting .devflow when a direct load omits the config field', async () => {
    const ctx = new Context()
    DevflowFsGuard.apply(ctx, {})
    const target = { targetKey: 'k' as never, displayPath: join('/ws', '.devflow', 'tasks', 'x', 'journal.jsonl') }
    await expect(ctx.waterfall('fs/write-intent', target, undefined, () => undefined)).rejects.toThrow(/devflow tools/)
    await expect(ctx.waterfall('fs/edit-intent', target, undefined, () => undefined)).rejects.toThrow(/devflow tools/)
  })

  it('fails the load on an empty or ill-formed protected-directory list', async () => {
    await expect(boot(['  config:', '    directories: []'])).rejects.toThrow(/directories/)
    await rm(workspace!, { recursive: true, force: true })
    await expect(boot(['  config:', "    directories: ['a/b']"])).rejects.toThrow(/directories/)
  }, 30_000)
})
