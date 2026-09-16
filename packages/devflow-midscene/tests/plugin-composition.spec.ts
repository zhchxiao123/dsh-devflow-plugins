import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry, { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import * as Midscene from '@zhchxiao123/dsh-devflow-midscene'

const SKILL = 'devflow-midscene-acceptance'
const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function boot(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'midscene-skill-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@zhchxiao123/dsh-devflow-midscene'",
    '',
  ].join('\n'))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@zhchxiao123/dsh-devflow-midscene', Midscene],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  return ctx
}

describe('Midscene acceptance in a real Loader composition', () => {
  it('serves the invocable acceptance runbook and withdraws it without destroying the registry', async () => {
    const ctx = await boot()
    expect((await ctx.skills.list()).map(entry => entry.name)).toEqual([SKILL, 'devflow-midscene-browser'])
    const browser = await ctx.skills.get('devflow-midscene-browser')
    expect(browser?.content).toContain('midscene_doctor')
    expect(browser?.content).toContain('official-browser/SKILL.md')
    const skill = await ctx.skills.get(SKILL)
    expect(skill?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(skill?.resourceBase?.kind).toBe('directory')
    expect(skill?.content).toBe(await readFile(new URL(`../assets/${SKILL}.md`, import.meta.url), 'utf8'))
    expect(skill?.content).toContain('midscene_bind')
    expect(skill?.content).toContain('Do not attach artifacts inside the transition waterfall')
    expect(skill?.content).toContain('midscene_run')
    const row = [...ctx.loader.entries()].find(entry => entry.options.name === '@zhchxiao123/dsh-devflow-midscene')
    expect(row?.fiber).toBeDefined()
    await row!.fiber!.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('allows a deployment to replace the acceptance instructions by skill name', async () => {
    const ctx = await boot()
    const candidate = {
      name: SKILL,
      description: 'Project-specific acceptance procedure',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'project-acceptance',
      source: 'custom',
      rank: BUNDLED_SKILL_RANK - 1,
      locator: null,
    }
    const dispose = ctx.skills.registerProvider(() => ({
      name: candidate.provider,
      list: () => Promise.resolve([candidate]),
      get: won => Promise.resolve({ ...won, content: 'Project acceptance' }),
    }))
    expect((await ctx.skills.get(SKILL))?.content).toBe('Project acceptance')
    dispose()
    expect((await ctx.skills.get(SKILL))?.provider).toBe(SKILL)
  })
})
