// REAL-composition proof: a cordis.yml booted through the actual Loader mounts
// the tools registry, a real local shell, an in-memory judgement, and this
// plugin — then triages an actual git repository with real changes on disk.
//
// The judgement is the only double. Everything a deployment would supply is
// the real thing, including `git` itself, because the two failures this tool
// can have that unit tests cannot see are "the command we build is not a
// command git accepts" and "the output git really prints does not split the
// way the parser expects".
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Triage from '@zhchxiao123/dsh-jev-triage'
import { MemoryJev, scoreAnswer } from './doubles.ts'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const cleanups: (() => Promise<unknown>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/**
 * Boot the composition over a repository that has one committed file changed
 * and one new file added, with a path that needs quoting.
 */
async function boot(): Promise<{ ctx: Context; jev: MemoryJev; repo: string }> {
  const base = await mkdtemp(join(tmpdir(), 'jev-triage-loader-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  // A directory name carrying a space and a quote: the command is one string,
  // so an unquoted interpolation would make git fail here rather than in
  // production.
  const repo = join(base, "my repo's checkout")
  await mkdtemp(repo).catch(() => undefined)
  execFileSync('mkdir', ['-p', repo])
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'loader@example.invalid')
  git(repo, 'config', 'user.name', 'loader')
  await writeFile(join(repo, 'README.md'), 'first\n')
  await writeFile(join(repo, 'auth.ts'), 'export const check = () => true\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  await writeFile(join(repo, 'README.md'), 'first\nsecond\n')
  await writeFile(join(repo, 'auth.ts'), 'export const check = (token: string) => token.length > 0\n')
  git(repo, 'add', '-A')

  const configPath = join(base, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-bash-local'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'memory-jev'",
    "- name: '@zhchxiao123/dsh-jev-triage'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(base).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', SubprocessLocal],
    ['@deepseek-ai/dsh-bash-local', BashLocal],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['memory-jev', MemoryJev],
    ['@zhchxiao123/dsh-jev-triage', Triage],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return await Promise.resolve(modules.get(specifier))
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, jev: ctx.get('jev') as MemoryJev, repo }
}

describe('jev-triage composed through the real Loader', () => {
  it('triages a real repository, splitting real git output into real verdicts', async () => {
    const { ctx, jev, repo } = await boot()
    jev.setScript({ answers: { f0: scoreAnswer(0, 0.97), f1: scoreAnswer(3, 0.93) } })

    const result = await ctx.tools.execute({
      name: 'jev_triage',
      arguments: { cwd: repo },
      callId: ToolCallId('loader-triage'),
      signal: new AbortController().signal,
    })

    expect(result.isError).toBeFalsy()
    const text = result.content.map(block => ('text' in block ? block.text : '')).join('\n')
    // git listed both changed files, and the quoted path reached it intact.
    expect(text).toContain('2 file(s) — 1 to review, 1 skipped')
    expect(text).toContain('SKIP  README.md')
    expect(text).toContain('REVIEW  auth.ts')
    // Each file was judged on its own diff, not on a shared blob of every diff.
    const questions = jev.calls[0]?.questions ?? {}
    expect(Object.keys(questions)).toHaveLength(2)
    expect(JSON.stringify(questions.f1)).toContain('token.length')
    expect(JSON.stringify(questions.f0)).not.toContain('token.length')
  })

  it('composes the real shell alongside the tool, so the diff is read by the deployment path', async () => {
    const { ctx } = await boot()
    expect(ctx.tools.get('jev_triage')).toBeDefined()
    // The shell here is `dsh-bash-local` over `dsh-subprocess-local`, in that
    // order: the base executor satisfies `inject: ['shell']` and can run
    // nothing, so a composition missing either would pass activation and then
    // fail on the first command.
    expect(ctx.get('shell')).toBeDefined()
  })
})
