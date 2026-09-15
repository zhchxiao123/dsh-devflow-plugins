/**
 * The function-plugin export surface the Loader reads, the validated Config,
 * and the wired apply: the workspace root resolves per call from the calling
 * agent session's working directory — never from the harness process cwd, so
 * a harness whose cwd points at its own checkout still serves the caller's
 * workspace — the five tools and the bundled skill register on the plugin
 * fiber, and disposing that fiber removes them.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import type { Agent } from '@deepseek-ai/dsh-agent'
import { emptyInbox } from '../../../tests/agent-double.ts'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as Testenv from '@zhchxiao123/dsh-devflow-testenv'

// Module-local declaration of the two `process` members this suite touches:
// the type-aware linter resolves the @types/node `process` global (and the
// `node:process` module) nondeterministically in this workspace, and a local
// declaration keeps its verdict stable. Runtime still binds the real global.
declare const process: { cwd(): string; chdir(directory: string): void }

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * An agent fixture carrying the session cwd the tools resolve the workspace
 * root from; one without a cwd exercises the fail-loud path. This suite has
 * no agent registry, and needs none — the tools read the agent off the
 * execution input.
 */
function agentWith(ctx: Context, name: string, cwd?: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, undefined, cwd === undefined
    ? undefined
    : { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false })
  return {
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
}

async function call(ctx: Context, name: string, args: object = {}, agent?: Agent): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `shape-${name}-${Math.random()}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  const content = result.content as { type: string; text?: string }[]
  return { isError: result.isError, text: content.filter(block => block.type === 'text').map(block => block.text).join('') }
}

async function bootPlugin(): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin({
    inject: ['tools', 'subprocess', 'skills'],
    apply: (child: Context) => { Testenv.apply(child, Testenv.Config({})) },
  })
  return { ctx, fiber }
}

describe('plugin export surface', () => {
  it('exposes the function-plugin shape with no default export', () => {
    expect(Testenv.name).toBe('testenv')
    expect(Testenv.inject).toEqual(['tools', 'subprocess', 'skills'])
    expect(typeof Testenv.apply).toBe('function')
    expect('default' in Testenv).toBe(false)
  })

  it('supplies the documented execution defaults', () => {
    expect(Testenv.Config({})).toEqual({
      manifestPath: 'testenv.yml',
      readyPollIntervalMs: 500,
      defaultReadyTimeoutMs: 60_000,
      downTimeoutMs: 30_000,
      testTimeoutMs: 600_000,
      logTailBytes: 65_536,
      graceMs: 5_000,
    })
  })

  it.each([
    ['readyPollIntervalMs', 0],
    ['defaultReadyTimeoutMs', -1],
    ['downTimeoutMs', 0.5],
    ['testTimeoutMs', 0],
    ['logTailBytes', 0],
    ['graceMs', 0],
  ] as const)('fails loud on a misconfigured %s', (key, value) => {
    expect(() => Testenv.Config({ [key]: value })).toThrow()
  })
})

describe('apply wiring', () => {
  it('resolves the root per call from the session cwd, never reading the harness checkout the process cwd points at', async () => {
    // The real deployment shape: the harness process cwd is its own checkout
    // — holding a decoy manifest — while the calling session's cwd is the
    // project workspace. Every call must resolve against the session cwd;
    // apply-time capture of the process cwd is exactly the defect this pins.
    const harnessCheckout = await mkdtemp(join(tmpdir(), 'testenv-harness-checkout-'))
    cleanups.push(() => rm(harnessCheckout, { recursive: true, force: true }))
    const decoy = [
      'services:',
      '  - name: decoy-from-harness',
      '    up: touch harness-marker',
      '    ready:',
      '      command: { run: "test -f harness-marker" }',
      'test: echo decoy',
      '',
    ].join('\n')
    await writeFile(join(harnessCheckout, 'testenv.yml'), decoy)

    const workspace = await mkdtemp(join(tmpdir(), 'testenv-workspace-'))
    cleanups.push(() => rm(workspace, { recursive: true, force: true }))
    await writeFile(join(workspace, 'testenv.yml'), [
      'services:',
      '  - name: rooted',
      '    up: touch marker-from-up',
      '    ready:',
      '      command: { run: "test -f marker-from-up" }',
      'test: echo shape-test',
      '',
    ].join('\n'))

    const previousCwd = process.cwd()
    process.chdir(harnessCheckout)
    try {
      const { ctx, fiber } = await bootPlugin()
      const caller = agentWith(ctx, 'shape-workspace-session', workspace)

      const up = await call(ctx, 'env_up', {}, caller)
      expect(up.isError).toBeFalsy()
      expect(up.text).toMatch(
        /^Environment is up in \d+(?:\.\d+)?m?s; every service is ready\.\n\[ready\] rooted \(command probe, ready in \d+(?:\.\d+)?m?s\)$/,
      )
      // The manifest and the service cwd resolved against the session cwd:
      // the workspace has the marker, the harness checkout has none, and its
      // decoy manifest went unread and unchanged.
      await access(join(workspace, 'marker-from-up'))
      await expect(access(join(harnessCheckout, 'harness-marker'))).rejects.toThrow()
      await expect(readFile(join(harnessCheckout, 'testenv.yml'), 'utf8')).resolves.toBe(decoy)
      expect((await ctx.skills.list()).some(entry => entry.name === 'testenv-bootstrap')).toBe(true)

      const down = await call(ctx, 'env_down', {}, caller)
      expect(down.isError).toBeFalsy()
      await fiber.dispose()
      expect(ctx.tools.get('env_up')).toBeUndefined()
      expect(ctx.tools.get('integration_test')).toBeUndefined()
      expect((await ctx.skills.list()).some(entry => entry.name === 'testenv-bootstrap')).toBe(false)
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('fails loud on a call without a session working directory instead of falling back to the process cwd', async () => {
    const { ctx } = await bootPlugin()

    const anonymous = await call(ctx, 'env_up')
    expect(anonymous.isError).toBe(true)
    expect(anonymous.text).toContain('testenv resolves the workspace root from the calling agent session\'s working directory')
    expect(anonymous.text).toContain('The harness process cwd is not a fallback')

    const cwdless = await call(ctx, 'env_status', {}, agentWith(ctx, 'shape-cwdless-session'))
    expect(cwdless.isError).toBe(true)
    expect(cwdless.text).toContain('its session was created without a cwd')
  })
})
