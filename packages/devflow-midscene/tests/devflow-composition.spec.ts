import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalBash from '@deepseek-ai/dsh-bash-local'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import Store from '@zhchxiao123/dsh-devflow-filesystem'
import * as Artifacts from '@zhchxiao123/dsh-devflow-artifact-gate'
import * as Gates from '@zhchxiao123/dsh-devflow-gates'
import * as DevflowTools from '@zhchxiao123/dsh-devflow-tool'
import { emptyInbox } from '../../../tests/agent-double.ts'
import { startModelFixture } from './support.ts'

const exec = promisify(execFile)
const cleanups: (() => Promise<unknown>)[] = []
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function temporary(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(workspace: string, command: string): Promise<{ ctx: Context; owner: Agent }> {
  const config = join(workspace, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-bash-local'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    '  config:',
    `    root: ${JSON.stringify(join(workspace, '.devflow'))}`,
    "- name: '@zhchxiao123/dsh-devflow-artifact-gate'",
    '  config:',
    '    kinds:',
    '      test-report:',
    '        frontmatter: [card, kind, title]',
    '        sections: [Scope, Results, Conclusion]',
    '    edges:',
    "      'testing->done': [test-report]",
    "- name: '@zhchxiao123/dsh-devflow-gates'",
    '  config:',
    '    edges:',
    `      'testing->done': [${JSON.stringify(command)}]`,
    '    policies:',
    "      'testing->done':",
    '        timeoutMs: 45000',
    "- name: '@zhchxiao123/dsh-devflow-tool'",
    '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocess],
    ['@deepseek-ai/dsh-bash-local', LocalBash],
    ['@deepseek-ai/dsh-agent', Agents],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@zhchxiao123/dsh-devflow-filesystem', Store],
    ['@zhchxiao123/dsh-devflow-artifact-gate', Artifacts],
    ['@zhchxiao123/dsh-devflow-gates', Gates],
    ['@zhchxiao123/dsh-devflow-tool', DevflowTools],
  ])
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(workspace).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const id = SessionId('midscene-composition-owner')
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: workspace, isSeeded: false,
  })
  const owner: Agent = {
    id, options: {}, session, inbox: emptyInbox(), ctx: ctx.plugin(() => {}).ctx, status: 'idle',
    followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(owner)
  return { ctx, owner }
}

it('registers actual CLI evidence through tools and reruns a real command gate before committing done', async () => {
  const workspace = await temporary('midscene-card-')
  const output = await temporary('midscene-evidence-')
  const fixture = await startModelFixture()
  cleanups.push(fixture.close)
  await exec('git', ['init', '-q'], { cwd: workspace })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: workspace })
  await writeFile(join(workspace, '.gitignore'), '.devflow/\n')
  const suite = join(workspace, 'suite.json')
  await writeFile(suite, JSON.stringify({
    version: 1, name: 'Loader acceptance', baseUrl: fixture.baseUrl,
    buildProbe: { path: '/build', expected: 'fixture-build' },
    cases: [{ id: 'visible-heading', steps: [{ kind: 'goto', path: '/' }, { kind: 'assert', prompt: 'Heading is visible' }] }],
  }))
  // Only the external model transport is controlled. The SDK, browser, CLI,
  // shell, tool registry, store, and transition policies all execute normally.
  const command = [
    `MIDSCENE_MODEL_BASE_URL=${quote(fixture.baseUrl + '/v1')}`,
    'MIDSCENE_MODEL_API_KEY=fixture-token-secret',
    quote(process.execPath), quote(fileURLToPath(new URL('../src/cli.ts', import.meta.url))),
    'run --suite', quote(suite), '--workspace', quote(workspace), '--output', quote(output),
    '--card 0001-acceptance --build-id fixture-build --model gpt-4o --timeout-ms 30000 --max-steps 10 --cleanup-timeout-ms 3000',
    ...(process.env.MIDSCENE_TEST_BROWSER ? ['--browser-executable-path', quote(process.env.MIDSCENE_TEST_BROWSER)] : []),
  ].join(' ')
  const { ctx, owner } = await boot(workspace, command)
  let call = 0
  const invoke = (name: string, args: object) => ctx.tools.execute({ name, arguments: args, agent: owner, signal: new AbortController().signal, callId: ToolCallId(`midscene-${++call}`) })
  expect((await invoke('devflow_create', { title: 'Acceptance', slug: 'acceptance', body: 'Validate visible heading' })).isError).toBe(false)
  const id = DevflowCardId('0001-acceptance')
  for (const stage of ['designing', 'ready', 'developing', 'reviewing', 'testing']) {
    const card = await ctx.devflow.read(id)
    expect((await invoke('devflow_transition', { id, to: stage, expectedRevision: card.stageRevision })).isError).toBe(false)
  }
  const before = await ctx.devflow.read(id)
  expect((await invoke('devflow_transition', { id, to: 'done', expectedRevision: before.stageRevision })).isError).toBe(true)
  expect(fixture.state.requests).toBe(0)
  const precheck = await ctx.shell.run(ctx.shell.resolve({ command, workdir: workspace, timeoutMs: 45000 }))
  expect(precheck.exitCode, JSON.stringify(precheck)).toBe(0)
  const [first] = await readdir(output)
  expect(first).toBeDefined()
  const summary = await readFile(join(output, first!, 'test-report.md'), 'utf8')
  expect((await invoke('devflow_attach_artifact', { id, kind: 'test-report', content: summary, expectedRevision: before.stageRevision })).isError).toBe(false)
  const registered = await ctx.devflow.read(id)
  expect(registered.artifactRecords).toHaveLength(1)
  fixture.state.answer = 'false'
  const requests = fixture.state.requests
  expect((await invoke('devflow_transition', { id, to: 'done', expectedRevision: registered.stageRevision })).isError).toBe(true)
  expect(fixture.state.requests).toBeGreaterThan(requests)
  expect((await ctx.devflow.read(id)).stage).toBe('testing')
  fixture.state.answer = 'true'
  expect((await invoke('devflow_transition', { id, to: 'done', expectedRevision: registered.stageRevision })).isError).toBe(false)
  expect((await ctx.devflow.read(id)).stage).toBe('done')
  expect(await readdir(output)).toHaveLength(3)
  expect((await ctx.devflow.history(id)).filter(entry => entry.type === 'transition' && entry.to === 'done')).toHaveLength(1)
}, 120_000)
