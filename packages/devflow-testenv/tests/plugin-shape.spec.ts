/**
 * The function-plugin export surface the Loader reads, the validated Config,
 * and the wired apply: the workspace root is the process cwd captured at apply
 * time, the five tools and the bundled skill register on the plugin fiber, and
 * disposing that fiber removes them.
 */
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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

async function call(ctx: Context, name: string, args: object = {}): Promise<{ isError: boolean | undefined; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `shape-${name}-${Math.random()}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
  })
  const content = result.content as { type: string; text?: string }[]
  return { isError: result.isError, text: content.filter(block => block.type === 'text').map(block => block.text).join('') }
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
  it('captures the process cwd as the workspace root and registers tools and skill on the plugin fiber', async () => {
    const root = await mkdtemp(join(tmpdir(), 'testenv-apply-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'testenv.yml'), [
      'services:',
      '  - name: rooted',
      '    up: touch marker-from-up',
      '    ready:',
      '      command: { run: "test -f marker-from-up" }',
      'test: echo shape-test',
      '',
    ].join('\n'))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)

    // The root is captured while the cwd points at the workspace; restoring
    // the cwd before any tool runs proves apply resolved it once, up front.
    const previousCwd = process.cwd()
    process.chdir(root)
    let fiber: { dispose(): Promise<void> }
    try {
      fiber = await ctx.plugin({
        inject: ['tools', 'subprocess', 'skills'],
        apply: (child: Context) => { Testenv.apply(child, Testenv.Config({})) },
      })
    } finally {
      process.chdir(previousCwd)
    }

    const up = await call(ctx, 'env_up')
    expect(up.isError).toBeFalsy()
    expect(up.text).toMatch(
      /^Environment is up in \d+(?:\.\d+)?m?s; every service is ready\.\n\[ready\] rooted \(command probe, ready in \d+(?:\.\d+)?m?s\)$/,
    )
    // The service cwd resolved against the captured root, not the restored cwd.
    await access(join(root, 'marker-from-up'))
    expect((await ctx.skills.list()).some(entry => entry.name === 'testenv-bootstrap')).toBe(true)

    const down = await call(ctx, 'env_down')
    expect(down.isError).toBeFalsy()
    await fiber.dispose()
    expect(ctx.tools.get('env_up')).toBeUndefined()
    expect(ctx.tools.get('integration_test')).toBeUndefined()
    expect((await ctx.skills.list()).some(entry => entry.name === 'testenv-bootstrap')).toBe(false)
  })
})
