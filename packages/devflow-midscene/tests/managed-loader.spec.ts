/** Real Loader, tools, agent ownership and local job lifecycle; only browser/model IO is external. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import * as Midscene from '../src/index.ts'
import { exploreBrowser } from '../src/browser.ts'
import { emptyInbox } from '../../../tests/agent-double.ts'
import { ValidatorRegistry } from '../../devflow-gates/src/validators.ts'

vi.mock('../src/model.ts', () => ({ resolveModel: async () => ({ environment: {}, redact: (text: string) => text, capability: 'available' }) }))
vi.mock('../src/browser.ts', () => ({ exploreBrowser: vi.fn() }))
let context: Context | undefined
let root: string | undefined
afterEach(async () => { await context?.fiber.dispose(); if (root) await rm(root, { recursive: true, force: true }) })

it('boots official skill and five tools; browser jobs are visible only to their owner and cancel through real registry', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'midscene-managed-loader-')))
  const workspace = root
  const ctx = new Context(); context = ctx
  const configPath = join(root, 'cordis.yml')
  const validators = new ValidatorRegistry()
  const systemPrompt = { name: 'test-system-prompt', apply: (child: Context) => {
    child.effect(() => child.provide('systemPrompt', { tools: () => () => {} }))
    child.effect(() => child.provide('devflowValidators', validators))
  } }
  const controller = { name: 'test-job-controller', inject: ['jobs'], apply: (child: Context) => {
    child.effect(() => child.jobs.attachController('test-visible-controller'))
  } }
  await writeFile(configPath, [
    '- name: test-system-prompt',
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-jobs-local'",
    '- name: test-job-controller',
    "- name: '@zhchxiao123/dsh-devflow-midscene'",
    '  config:', '    profiles:', '      local:',
    `        workspace: ${JSON.stringify(root)}`,
    `        output: ${JSON.stringify(join(root, '..', 'midscene-loader-output'))}`,
    '        targetUrl: http://localhost:3082', '        model: visual-model', '        family: glm-v',
    '        baseUrl: https://model.test/v1', '        credentialRef: VISUAL_KEY', '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['test-system-prompt', systemPrompt], ['test-job-controller', controller],
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skill', SkillRegistry], ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry],
    ['@zhchxiao123/dsh-devflow-midscene', Midscene],
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
  expect(validators.generation).toBe(1)
  const agent = (name: string): Agent => {
    const id = SessionId(name)
    const scope = ctx.plugin(() => {})
    const base = Session.create(id)
    const owner: Agent = { id, options: {}, session: Session.create(id, [], { ...base.header, cwd: workspace }),
      inbox: emptyInbox(), status: 'idle', ctx: scope.ctx, followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
    ctx.agents.register(owner)
    return owner
  }
  const owner = agent('loader-owner')
  const foreign = agent('other-owner')
  for (const name of ['midscene_doctor', 'midscene_browser', 'midscene_run', 'midscene_inspect', 'midscene_recover']) expect(ctx.tools.get(name)).toBeDefined()
  expect((await ctx.skills.list()).map(skill => skill.name)).toContain('devflow-midscene-acceptance')
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  vi.mocked(exploreBrowser).mockImplementationOnce(async (profile, _args, _model, signal) => {
    started()
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }) })
    return { runId: 'cancelled-run', status: 'cancelled', purpose: 'exploration', workspace: profile.workspace,
      directory: profile.output, cleanup: 'confirmed', output: '', artifacts: [] }
  })
  const result = await ctx.tools.execute({ name: 'midscene_browser', arguments: {}, agent: owner,
    callId: 'loader-browser' as ToolExecutionInput['callId'], signal: new AbortController().signal })
  expect(result.isError).not.toBe(true)
  await ready
  const jobs = ctx.jobs.list(owner)
  expect(jobs).toHaveLength(1)
  expect(ctx.jobs.list(foreign)).toHaveLength(0)
  ctx.jobs.start({ kind: 'bash', owner, label: 'other producer', run: () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }) })
  expect(await ctx.devflowMidsceneSummary.read(owner.id, '0001-card')).toMatchObject({ available: true, jobs: [{ id: 'midscene-1', status: 'running' }] })
  expect((await ctx.devflowMidsceneSummary.read(foreign.id, '0001-card')).jobs).toEqual([])
  const id = JobId('midscene-1')
  expect(() => ctx.jobs.get(id, foreign)).toThrow()
  expect(ctx.jobs.kill(id, owner)).toBe('requested')
  expect((await ctx.jobs.wait(id, 1000, owner)).status).toBe('killed')
  const plugin = [...ctx.loader.entries()].find(entry => entry.options.name === '@zhchxiao123/dsh-devflow-midscene')
  if (!plugin?.fiber) throw new Error('plugin missing')
  await plugin.fiber.dispose()
  expect(validators.generation).toBe(2)
  expect(ctx.tools.get('midscene_browser')).toBeUndefined()
  expect(ctx.get('devflowMidsceneSummary')).toBeUndefined()
  expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('devflow-midscene-acceptance')
})
