import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
/** The actual Loader and task store own the complete project-default acceptance transition. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import Approval from '@deepseek-ai/dsh-user-approval'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Bash from '@deepseek-ai/dsh-bash-local'
import Store from '@zhchxiao123/dsh-devflow-filesystem'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import * as Gates from '../../devflow-gates/src/index.ts'
import * as Midscene from '../src/index.ts'
import { workspaceIdentity } from '../src/identity.ts'
import { emptyInbox } from '../../../tests/agent-double.ts'

it('binds reviewed project acceptance, attaches its report, and commits done only after a fresh browser gate', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'midscene-project-flow-')))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const ctx = new Context()
  const app = createServer((request, response) => {
    response.end(request.url === '/build' ? JSON.stringify({ build: 'fixture-build', instance: 'instance-1' }) : '<h1>Acceptance fixture</h1>')
  })
  app.listen(0, '127.0.0.1'); await once(app, 'listening')
  const fixture = { baseUrl: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, close: async () => { app.closeAllConnections(); await new Promise<void>((resolve) => { app.close(() => { resolve() }) }) } }
  vi.stubEnv('DSH_HOME', home)
  const exec = promisify(execFile)
  let calls = 0
  let images = 0
  try {
    await exec('git', ['init', '-q', workspace])
    await exec('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
    const cardId = DevflowCardId('0001-project-acceptance')
    const cardDir = join(workspace, '.devflow', 'tasks', cardId)
    await mkdir(cardDir, { recursive: true })
    await writeFile(join(cardDir, 'card.md'), '---\ntitle: Project acceptance\n---\nThe acceptance fixture heading is visible.\n')
    const stages = ['draft', 'designing', 'ready', 'developing', 'reviewing', 'testing']
    await writeFile(join(cardDir, 'journal.jsonl'), [JSON.stringify({ rev: 1, at: 't1', type: 'created', by: { kind: 'human' } }), ...stages.slice(1).map((to, index) => JSON.stringify({ rev: index + 2, at: `t${index + 2}`, type: 'transition', from: stages[index], to }))].join('\n') + '\n')
    const configPath = join(root, 'cordis.yml')
    const support = { name: 'flow-support', apply(child: Context) { child.effect(() => child.provide('systemPrompt', { tools: () => () => {} })) } }
    const controller = { name: 'flow-controller', inject: ['jobs'], apply(child: Context) { child.effect(() => child.jobs.attachController('visible-flow-controller')) } }
    await writeFile(configPath, [
      '- name: flow-support',
      "- name: '@deepseek-ai/dsh-agent'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-skill'",
      "- name: '@deepseek-ai/dsh-jobs-local'", '- name: flow-controller',
      "- name: '@deepseek-ai/dsh-user-approval'", '  config:', '    policy: ask',
      "- name: '@deepseek-ai/dsh-llm'", "- name: '@deepseek-ai/dsh-attachment-local'", '  config:', `    dshHome: ${JSON.stringify(home)}`,
      "- name: '@deepseek-ai/dsh-subprocess-local'", "- name: '@deepseek-ai/dsh-bash-local'",
      "- name: '@zhchxiao123/dsh-devflow-filesystem'", '  config:', `    root: ${JSON.stringify(join(workspace, '.devflow'))}`,
      "- name: '@zhchxiao123/dsh-devflow-gates'", "- name: '@zhchxiao123/dsh-devflow-midscene'", '  config:', '    profiles: {}', '',
    ].join('\n'))
    const modules = new Map<string, unknown>([
      ['flow-support', support], ['flow-controller', controller], ['@deepseek-ai/dsh-agent', Agents], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-skill', Skills], ['@deepseek-ai/dsh-jobs-local', Jobs], ['@deepseek-ai/dsh-user-approval', Approval],
      ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-attachment-local', Attachments], ['@deepseek-ai/dsh-subprocess-local', Subprocess],
      ['@deepseek-ai/dsh-bash-local', Bash], ['@zhchxiao123/dsh-devflow-filesystem', Store], ['@zhchxiao123/dsh-devflow-gates', Gates], ['@zhchxiao123/dsh-devflow-midscene', Midscene],
    ])
    ctx.baseUrl = pathToFileURL(root + '/').href
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected import: ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    class ExternalProvider extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model, inputModalities: ['image'] } }
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        calls++
        for (const message of options.messages) for (const block of message.content) if (block.type === 'image') {
          const image = await ctx.attachments.readImage(block.attachment)
          expect(image.data.length).toBeGreaterThan(100); images++
        }
        const text = '<observation>Controlled provider response, not visual accuracy proof.</observation><data-json>{"StatementIsTruthy":true}</data-json>'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['configured'], new ExternalProvider())
    const approval = vi.spyOn(ctx.approval, 'request').mockResolvedValue('allowed-once')
    const id = SessionId('project-flow-owner'); const base = Session.create(id)
    const session = Session.create(id, [], { ...base.header, cwd: workspace })
    session.append('request/header', { header: { config: { provider: 'configured', model: 'gpt-5' } }, reason: 'initial' })
    const owner: Agent = { id, options: {}, session, inbox: emptyInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx, followup() {}, steer() {}, inject() {}, send() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
    ctx.agents.register(owner)
    const claim = await ctx.devflow.claim(cardId, { kind: 'agent', session: id })
    expect(claim.ok).toBe(true)
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({ name, arguments: args, agent: owner, callId: ToolCallId(`flow-${name}`), signal: new AbortController().signal })
      const text = result.content.map(part => part.type === 'text' ? part.text : '').join('\n')
      expect(result.isError, text).toBe(false)
      return text
    }
    await tool('midscene_project', { settings: JSON.stringify({ targetUrl: fixture.baseUrl, limits: { timeoutMs: 25000, cleanupTimeoutMs: 3000, maxSteps: 5 } }) })
    expect(await tool('midscene_discover', {})).toContain('ready')
    const receipt = join(root, 'deployment.json')
    await writeFile(receipt, JSON.stringify({ version: 1, ...await workspaceIdentity(workspace), buildId: 'fixture-build' }), { mode: 0o600 })
    const suiteJson = JSON.stringify({ version: 1, name: 'Project task acceptance', baseUrl: fixture.baseUrl, buildProbe: { path: '/build', format: 'json', field: ['build'], instanceField: ['instance'], expected: 'fixture-build' }, cases: [{ id: 'heading', steps: [{ kind: 'goto', path: '/' }, { kind: 'assert', prompt: 'Acceptance fixture heading is visible' }] }] })
    expect(await tool('midscene_bind', { card: cardId, suiteJson, deploymentRecord: receipt })).toContain('Bound')
    expect(approval).toHaveBeenCalledOnce()
    expect(await tool('midscene_run', { card: cardId })).toContain('Started midscene-1')
    const job = await ctx.jobs.wait(JobId('midscene-1'), 30000, owner)
    expect(job.status, JSON.stringify(job)).toBe('completed')
    const beforeGateCalls = calls
    expect(beforeGateCalls).toBeGreaterThan(0)
    const card = await ctx.devflow.read(cardId)
    expect(card.stage).toBe('testing')
    expect(await readFile(join(cardDir, 'journal.jsonl'), 'utf8')).toContain('test-report')
    const transition = await ctx.devflow.transition(ctx.devflow.resolve({ id: cardId, to: 'done', expectedRevision: card.stageRevision, by: { kind: 'agent', session: id } }))
    expect(transition, JSON.stringify(transition)).toMatchObject({ ok: true })
    expect((await ctx.devflow.read(cardId)).stage).toBe('done')
    expect(calls).toBeGreaterThan(beforeGateCalls)
    expect(images).toBeGreaterThan(1)
    expect(ctx.jobs.list(owner).length).toBeGreaterThan(1)
    const journal = await readFile(join(cardDir, 'journal.jsonl'), 'utf8')
    expect(journal).toContain('midscene:project')
    expect(JSON.parse(journal.trim().split('\n').at(-1) as string)).toMatchObject({ type: 'transition', to: 'done', gate: { checks: [{ verdict: 'allowed', by: { name: 'midscene:project' } }] } })
    if (claim.ok) await claim.handle.release()
  } finally {
    vi.restoreAllMocks(); await ctx.fiber.dispose(); await fixture.close(); vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
