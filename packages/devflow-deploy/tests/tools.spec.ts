// The tools over a stub engine. Driving them this way rather than through the
// plugin is deliberate: the renders cover all three rollback classes, and the
// composition only ever registers a driver for one of them. A kind that
// promises a disruptive or unsupported rollback must already render correctly
// before its driver exists — that is what makes the seam addable-to.
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { emptyInbox } from '../../../tests/agent-double.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeployEngine, DeployReport, StatusReport } from '../src/engine.ts'
import { ManifestError } from '../src/manifest.ts'
import { UnknownKindError } from '../src/registry.ts'
import { registerTools } from '../src/tools.ts'
import type { RollbackClass, TargetStatus } from '../src/types.ts'

interface StubEngine {
  deploy?: (name: string) => Promise<DeployReport>
  rollback?: (name: string, to?: string) => Promise<DeployReport>
  status?: (name?: string) => Promise<StatusReport>
}

let ctx: Context
let dispose: () => void
let stub: StubEngine

const REPORT: DeployReport = {
  target: 'landing',
  kind: 'static',
  outcome: { releaseId: '20260903T190000Z', url: 'https://example.test/landing/' },
  timeline: [{ phase: 'preflight', durationMs: 4 }, { phase: 'activate', durationMs: 11 }],
  warnings: [],
  durationMs: 15,
}

function statusOf(...targets: TargetStatus[]): StatusReport {
  return { targets, durationMs: 3 }
}

function target(name: string, rollbackClass: RollbackClass, extra: Partial<TargetStatus> = {}): TargetStatus {
  return { name, kind: 'demo', rollbackClass, releases: [], ...extra }
}

beforeEach(async () => {
  ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  stub = {}
  sessions = 0
  const fiber = await ctx.plugin({
    inject: ['tools'],
    apply: (child: Context) => {
      registerTools(child, () => stub as unknown as DeployEngine)
    },
  })
  dispose = (): void => {
    void fiber.dispose()
  }
})

afterEach(() => {
  dispose()
})

let sessions = 0

function sessionAgent(cwd: string | undefined): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(`tools-session-${sessions++}`)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    ...cwd === undefined ? {} : { cwd },
  })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: emptyInbox(),
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

async function call(name: string, args: object = {}, cwd: string | undefined = '/ws'): Promise<{ isError: boolean | undefined; text: string }> {
  return callWith(name, args, cwd)
}

/** Distinct from `call` so a deliberately absent cwd is not read as "use the default". */
async function callWithoutCwd(name: string, args: object): Promise<{ isError: boolean | undefined; text: string }> {
  return callWith(name, args, undefined)
}

async function callWith(name: string, args: object, cwd: string | undefined): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `deploy-tools-${name}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
    agent: sessionAgent(cwd),
  })
  const content = result.content as { type: string; text?: string }[]
  return {
    isError: result.isError,
    text: content.filter(block => block.type === 'text').map(block => block.text ?? '').join(''),
  }
}

describe('deploy_target', () => {
  it('leads with the verdict, the address, and the phase timeline', async () => {
    stub.deploy = () => Promise.resolve(REPORT)

    const result = await call('deploy_target', { target: 'landing' })

    expect(result.text).toBe([
      'Deployed landing to release 20260903T190000Z in 15ms.',
      'Reachable at https://example.test/landing/',
      '  preflight: 4ms',
      '  activate: 11ms',
    ].join('\n'))
  })

  it('omits the address for a kind that has none', async () => {
    stub.deploy = () => Promise.resolve({ ...REPORT, outcome: { releaseId: 'v1' } })

    const result = await call('deploy_target', { target: 'landing' })

    expect(result.text).not.toContain('Reachable at')
  })

  it('reports warnings under a successful deploy', async () => {
    stub.deploy = () => Promise.resolve({ ...REPORT, warnings: ['two releases could not be removed'] })

    const result = await call('deploy_target', { target: 'landing' })

    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('Warnings:\n  two releases could not be removed')
  })

  it('passes the requested target through', async () => {
    const seen: string[] = []
    stub.deploy = (name) => {
      seen.push(name)
      return Promise.resolve(REPORT)
    }

    await call('deploy_target', { target: 'docs' })

    expect(seen).toEqual(['docs'])
  })
})

describe('deploy_rollback', () => {
  it('names the rollback in its verdict', async () => {
    stub.rollback = () => Promise.resolve(REPORT)

    const result = await call('deploy_rollback', { target: 'landing' })

    expect(result.text).toContain('Rolled back landing to release 20260903T190000Z')
  })

  it('passes the requested release through', async () => {
    const seen: (string | undefined)[] = []
    stub.rollback = (_name, to) => {
      seen.push(to)
      return Promise.resolve(REPORT)
    }

    await call('deploy_rollback', { target: 'landing', to: 'v1' })
    await call('deploy_rollback', { target: 'landing' })

    expect(seen).toEqual(['v1', undefined])
  })
})

describe('deploy_status', () => {
  it('reports nothing to report when the manifest declares no targets', async () => {
    stub.status = () => Promise.resolve(statusOf())

    await expect(call('deploy_status')).resolves.toMatchObject({ text: 'deploy.yml declares no targets.' })
  })

  it('says so for a target that has never been deployed', async () => {
    stub.status = () => Promise.resolve(statusOf(target('landing', { kind: 'atomic' })))

    const result = await call('deploy_status')

    expect(result.text).toContain('landing (demo): nothing deployed yet.')
    expect(result.text).toContain('rollback: atomic')
  })

  it('reports the current release, its address, and the earlier releases', async () => {
    stub.status = () => Promise.resolve(statusOf(target('landing', { kind: 'atomic' }, {
      currentRelease: 'v3',
      url: 'https://example.test/landing/',
      releases: [{ id: 'v3', current: true }, { id: 'v2', current: false }, { id: 'v1', current: false }],
    })))

    const result = await call('deploy_status')

    expect(result.text).toContain('release v3 at https://example.test/landing/')
    expect(result.text).toContain('earlier releases: v2, v1')
  })

  it('omits the history when only the current release exists', async () => {
    stub.status = () => Promise.resolve(statusOf(target('landing', { kind: 'atomic' }, {
      currentRelease: 'v1',
      releases: [{ id: 'v1', current: true }],
    })))

    expect((await call('deploy_status')).text).not.toContain('earlier releases')
  })

  it('carries the note of a disruptive rollback', async () => {
    stub.status = () => Promise.resolve(statusOf(
      target('api', { kind: 'disruptive', note: 'the container restarts' }),
    ))

    expect((await call('deploy_status')).text).toContain('rollback: disruptive — the container restarts')
  })

  it('carries the reason no rollback is promised', async () => {
    stub.status = () => Promise.resolve(statusOf(
      target('cluster', { kind: 'unsupported', reason: 'the delegate decides reversibility' }),
    ))

    expect((await call('deploy_status')).text)
      .toContain('rollback: unsupported — the delegate decides reversibility')
  })

  it('reports every target when none is named', async () => {
    const seen: (string | undefined)[] = []
    stub.status = (name) => {
      seen.push(name)
      return Promise.resolve(statusOf())
    }

    await call('deploy_status')
    await call('deploy_status', { target: 'landing' })

    expect(seen).toEqual([undefined, 'landing'])
  })
})

describe('failures the skill owns', () => {
  it('appends the repair pointer to a manifest defect', async () => {
    stub.deploy = () => Promise.reject(new ManifestError('/ws/deploy.yml is invalid', ['targets.landing.dir: bad']))

    const result = await call('deploy_target', { target: 'landing' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('targets.landing.dir: bad')
    expect(result.text).toContain('Run the `deploy-bootstrap` skill')
  })

  it('appends the repair pointer to an unregistered kind', async () => {
    stub.deploy = () => Promise.reject(new UnknownKindError('playbook', ['static']))

    const result = await call('deploy_target', { target: 'cluster' })

    expect(result.text).toContain('registered kinds: static')
    expect(result.text).toContain('Run the `deploy-bootstrap` skill')
  })

  it('leaves every other failure alone', async () => {
    stub.deploy = () => Promise.reject(new Error('the host refused the connection'))

    const result = await call('deploy_target', { target: 'landing' })

    expect(result.text).toContain('the host refused the connection')
    expect(result.text).not.toContain('deploy-bootstrap')
  })
})

describe('the workspace root', () => {
  it.each([
    ['deploy_target', { target: 'landing' }],
    ['deploy_status', {}],
    ['deploy_rollback', { target: 'landing' }],
  ])('refuses %s from a session without a working directory', async (name, args) => {
    const result = await callWithoutCwd(name, args)

    expect(result.isError).toBe(true)
    expect(result.text).toContain('The harness process cwd is not a fallback')
  })
})

describe('how a call is presented before it runs', () => {
  it.each([
    ['deploy_target', { target: 'landing' }, 'Deploy landing', 'execute'],
    ['deploy_rollback', { target: 'landing' }, 'Roll back landing', 'execute'],
    ['deploy_status', { target: 'landing' }, 'Report landing', 'read'],
  ])('titles %s', (name, args, title, kind) => {
    expect(ctx.tools.get(name)?.presentCall?.(args)).toMatchObject({ title, kind })
  })

  it('titles a status call that names no target', () => {
    expect(ctx.tools.get('deploy_status')?.presentCall?.({}))
      .toMatchObject({ title: 'Report every deployed target', kind: 'read' })
  })
})
