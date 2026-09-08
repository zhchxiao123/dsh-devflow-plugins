// REAL-composition proof: a cordis.yml booted through the actual Loader mounts
// the subprocess runtime, the tool runtime, the skill registry, the agent
// registry, and this plugin, then the registered tools publish a real artifact
// for the calling session's workspace — the root resolves per call from that
// session's cwd, the render is what the model sees, and the symlink and
// payload land on the "remote" filesystem.
//
// The load-bearing assertion is what happens after `dispose`: the tools, the
// skill, and the driver registration all go away, and everything published
// stays exactly where it is. That is the promise this package makes and the
// one a test environment makes in reverse, so it is proven through the Loader
// rather than asserted in a unit.
import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as Deploy from '../src/index.ts'
import { createDockerDouble, useDockerPath } from './docker-double.ts'
import { createRemoteDouble, usePath } from './remote-double.ts'
import type { RemoteDouble } from './remote-double.ts'

const cleanups: (() => Promise<unknown>)[] = []
let context: Context | undefined
let restorePath: (() => void) | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  restorePath?.()
  restorePath = undefined
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function writeWorkspace(withManifest = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deploy-loader-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  if (withManifest) {
    await writeFile(join(root, 'deploy.yml'), [
      'targets:',
      '  landing:',
      '    kind: static',
      '    build: mkdir -p dist && printf "<h1>published</h1>" > dist/index.html',
      '    dir: dist',
      '',
    ].join('\n'))
  }
  return root
}

async function boot(root: string, remote: RemoteDouble): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@zhchxiao123/dsh-devflow-deploy'",
    '  config:',
    "    host: 'deploy@example.test'",
    '    drivers:',
    '      static:',
    `        remoteWebRoot: '${remote.remoteWebRoot}'`,
    `        remoteReleasesRoot: '${remote.remoteReleasesRoot}'`,
    "        baseUrl: 'https://example.test'",
    '    graceMs: 300',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  // The tool runtime injects the system-prompt service; the real provider
  // package is not resolvable in this workspace, so the boot provides the one
  // member the runtime touches — the same stub the other suites use.
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@zhchxiao123/dsh-devflow-deploy', Deploy],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  // The workspace root resolves per call from the calling session's cwd, so
  // the boot never touches the process cwd — in a real deployment that points
  // at the harness checkout.
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function sessionIn(ctx: Context, root: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(`deploy-session-${basename(root)}`)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: root, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: unknown }): string {
  const content = result.content as { type: string; text?: string }[]
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

async function call(
  ctx: Context,
  name: string,
  args: object = {},
  agent?: Agent,
): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `deploy-loader-${name}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return { isError: result.isError, text: resultText(result) }
}

async function bootedWorkspace(withManifest = true): Promise<{ ctx: Context; root: string; agent: Agent; remote: RemoteDouble }> {
  const remote = await createRemoteDouble()
  const root = await writeWorkspace(withManifest)
  restorePath = usePath(remote)
  const ctx = await boot(root, remote)
  return { ctx, root, agent: sessionIn(ctx, root), remote }
}

describe('the deploy plugin under the real Loader', () => {
  it('registers its tools and its bundled skill', async () => {
    const { ctx } = await bootedWorkspace()

    expect(ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('deploy_')).sort())
      .toEqual(['deploy_rollback', 'deploy_status', 'deploy_target'])
    const catalog = await ctx.skills.list()
    expect(catalog.some(entry => entry.name === 'deploy-bootstrap')).toBe(true)
  })

  it('loads the bundled skill body from the shipped assets directory', async () => {
    const { ctx } = await bootedWorkspace()

    const skill = await ctx.skills.get('deploy-bootstrap')

    expect(skill?.provider).toBe('deploy-bootstrap')
    expect(skill?.content).toContain('# deploy-bootstrap')
    expect(skill?.content).toContain('Read the failure by its phase')
  })

  it('builds, publishes, and reports where the target can be reached', async () => {
    const { ctx, agent, remote } = await bootedWorkspace()

    const result = await call(ctx, 'deploy_target', { target: 'landing' }, agent)

    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('Reachable at https://example.test/landing/')
    expect(result.text).toContain('build:')
    expect(result.text).toContain('activate:')
    await expect(readFile(join(remote.remoteWebRoot, 'landing', 'index.html'), 'utf8'))
      .resolves.toBe('<h1>published</h1>')
  })

  it('reports the target, its address, and its rollback promise', async () => {
    const { ctx, agent } = await bootedWorkspace()
    await call(ctx, 'deploy_target', { target: 'landing' }, agent)

    const result = await call(ctx, 'deploy_status', {}, agent)

    expect(result.text).toContain('landing (static)')
    expect(result.text).toContain('rollback: atomic')
    expect(result.text).toContain('https://example.test/landing/')
  })

  it('points a workspace without a manifest at the skill that writes one', async () => {
    const { ctx, agent } = await bootedWorkspace(false)

    const result = await call(ctx, 'deploy_target', { target: 'landing' }, agent)

    expect(result.isError).toBe(true)
    expect(result.text).toContain('deploy.yml')
    expect(result.text).toContain('Run the `deploy-bootstrap` skill')
  })

  it('refuses a call that carries no session working directory', async () => {
    const { ctx } = await bootedWorkspace()

    const result = await call(ctx, 'deploy_status', {})

    expect(result.isError).toBe(true)
    expect(result.text).toContain('The harness process cwd is not a fallback')
  })

  it('leaves everything it published in place when the whole composition is disposed', async () => {
    const { ctx, agent, remote } = await bootedWorkspace()
    const deployed = await call(ctx, 'deploy_target', { target: 'landing' }, agent)
    expect(deployed.isError).toBeFalsy()
    const releaseBefore = await readlink(join(remote.remoteWebRoot, 'landing'))

    await ctx.fiber.dispose()
    context = undefined

    await expect(readlink(join(remote.remoteWebRoot, 'landing'))).resolves.toBe(releaseBefore)
    await expect(readFile(join(remote.remoteWebRoot, 'landing', 'index.html'), 'utf8'))
      .resolves.toBe('<h1>published</h1>')
    await expect(readdir(join(remote.remoteReleasesRoot, 'landing')))
      .resolves.toEqual([basename(releaseBefore)])
  })
})

describe('disposing the plugin alone', () => {
  it('removes its tools, its skill, and its driver, and keeps what it published', async () => {
    const remote = await createRemoteDouble()
    const root = await writeWorkspace()
    restorePath = usePath(remote)
    const ctx = new Context()
    context = ctx
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(Deploy, {
      host: 'deploy@example.test',
      drivers: {
        static: {
          remoteWebRoot: remote.remoteWebRoot,
          remoteReleasesRoot: remote.remoteReleasesRoot,
          baseUrl: 'https://example.test',
        },
      },
      graceMs: 300,
    })
    const agent = sessionIn(ctx, root)
    expect((await call(ctx, 'deploy_target', { target: 'landing' }, agent)).isError).toBeFalsy()
    const releaseBefore = await readlink(join(remote.remoteWebRoot, 'landing'))

    await fiber.dispose()

    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('deploy_'))).toEqual([])
    expect((await ctx.skills.list()).some(entry => entry.name === 'deploy-bootstrap')).toBe(false)
    await expect(readlink(join(remote.remoteWebRoot, 'landing'))).resolves.toBe(releaseBefore)
    await expect(readFile(join(remote.remoteWebRoot, 'landing', 'index.html'), 'utf8'))
      .resolves.toBe('<h1>published</h1>')
  })
})

describe('the service kind under the real Loader', () => {
  it('publishes a container and leaves it running when the plugin is disposed', async () => {
    const docker = await createDockerDouble()
    const root = await mkdtemp(join(tmpdir(), 'deploy-loader-svc-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'deploy.yml'), [
      'targets:',
      '  api:',
      '    kind: service',
      '    image: myapp',
      '    service: api',
      '    ready: { docker: health }',
      '',
    ].join('\n'))
    restorePath = useDockerPath(docker)

    const ctx = new Context()
    context = ctx
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(Deploy, {
      host: 'deploy@example.test',
      drivers: {
        service: {
          composeDir: docker.composeDir,
          remoteTmpDir: join(docker.storeDir, 'tmp'),
          verifyTimeoutMs: 2_000,
          readyPollIntervalMs: 20,
        },
      },
      graceMs: 300,
    })
    const agent = sessionIn(ctx, root)

    const deployed = await call(ctx, 'deploy_target', { target: 'api' }, agent)
    expect(deployed.isError).toBeFalsy()
    const status = await call(ctx, 'deploy_status', {}, agent)
    expect(status.text).toContain('api (service)')
    expect(status.text).toContain('rollback: disruptive —')
    const runningBefore = await docker.running()
    expect(runningBefore).toBeDefined()

    await fiber.dispose()

    // The container outlives the plugin; only the plugin's own registrations go.
    expect(await docker.running()).toBe(runningBefore)
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('deploy_'))).toEqual([])
  }, 30_000)
})

describe('configuration that names an unusable server', () => {
  it('refuses a releases root inside the served tree', () => {
    expect(() => Deploy.resolveStaticConfig({
      remoteWebRoot: '/srv/www',
      remoteReleasesRoot: '/srv/www/releases',
      baseUrl: 'https://example.test',
    })).toThrow('must sit outside remoteWebRoot')
  })

  it('refuses a composition that registers no kind at all', async () => {
    const ctx = new Context()
    context = ctx
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)

    await expect(ctx.plugin(Deploy, { host: 'deploy@example.test' }))
      .rejects.toThrow('configured with no target kinds')
  })

  it('refuses a section naming a kind this package does not ship', async () => {
    const ctx = new Context()
    context = ctx
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)

    await expect(ctx.plugin(Deploy, { host: 'deploy@example.test', drivers: { playbook: {} } }))
      .rejects.toThrow('configurable kinds: static')
  })
})
