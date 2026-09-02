/**
 * The bundled `testenv-bootstrap` provider against a real skill registry: the
 * advertised catalog entry, the loaded body (read from the shipped assets),
 * the bundled rank losing to a lower-ranked same-layer rival, and removal on
 * fiber disposal.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillProvider } from '@deepseek-ai/dsh-skill'
import { registerSkill } from '../src/skill.ts'

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function bootSkills(): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin({
    inject: ['skills'],
    apply: (child: Context) => { registerSkill(child) },
  })
  return { ctx, fiber }
}

describe('the bundled testenv-bootstrap skill', () => {
  it('advertises one model- and user-invocable bundled skill with its assets directory', async () => {
    const { ctx } = await bootSkills()
    const summaries = await ctx.skills.list()
    const summary = summaries.find(entry => entry.name === 'testenv-bootstrap')
    expect(summary).toBeDefined()
    expect(summary?.provider).toBe('testenv-bootstrap')
    expect(summary?.source).toBe('bundled')
    expect(summary?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(summary?.description).toContain('testenv.yml')
    expect(summary?.description).toContain('env_up')
    expect(summary?.resourceBase?.kind).toBe('directory')
    if (summary?.resourceBase?.kind === 'directory') {
      expect(summary.resourceBase.path).toContain(join('devflow-testenv', 'assets'))
    }
  })

  it('loads the eight-section survey protocol from the shipped assets file', async () => {
    const { ctx } = await bootSkills()
    const skill = await ctx.skills.get('testenv-bootstrap')
    expect(skill).toBeDefined()
    expect(skill?.content).toBe(
      await readFile(new URL('../assets/testenv-bootstrap.md', import.meta.url), 'utf8'),
    )
    expect(skill?.content).toContain('## 1. Survey the test landscape')
    expect(skill?.content).toContain('.github/workflows')
    expect(skill?.content).toContain('## 5. Write the manifest, comments complete')
    expect(skill?.content).toContain('test: pnpm run test:integration')
    expect(skill?.content).toContain('never into the harness checkout')
    expect(skill?.content).toContain('## 6. Prove the loop, then falsify it')
    expect(skill?.content).toContain('`env_down` reports no residue')
    expect(skill?.content).toContain('## 8. Repair a rotten manifest')
  })

  it('pins the survey protocol contract sentences', async () => {
    const { ctx } = await bootSkills()
    const body = (await ctx.skills.get('testenv-bootstrap'))?.content ?? ''
    // The premature-convergence wording this protocol replaced must not return.
    expect(body).not.toContain('stop as soon as')
    expect(body).toContain(
      'The survey is complete when every entry point is classified, not when the first runnable suite is found',
    )
    expect(body).toContain('A fully mocked suite must not be chosen as `test`')
    expect(body).toContain('The run must turn red')
    expect(body).toContain('## 7. Report the survey')
    expect(body).toContain(
      'exactly one test configuration, one CI test job, and no workspace or monorepo structure',
    )
    // File discipline survives the rewrite verbatim.
    expect(body).toContain('The manifest is this skill\'s only persistent artifact.')
    expect(body).toContain('not something to bridge by writing a shim manifest where the tool looked')
  })

  it('yields the name to a lower-ranked same-layer provider and returns once that rival leaves', async () => {
    const { ctx } = await bootSkills()
    const rival: SkillProvider = {
      name: 'rival',
      list: () => Promise.resolve([{
        name: 'testenv-bootstrap',
        description: 'project-local override',
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'rival',
        source: 'custom',
        rank: BUNDLED_SKILL_RANK - 1,
        locator: null,
      }]),
      get: candidate => Promise.resolve({
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: candidate.provider,
        source: candidate.source,
        content: 'rival body',
      }),
    }
    const dispose = ctx.skills.registerProvider(() => rival)
    expect((await ctx.skills.get('testenv-bootstrap'))?.content).toBe('rival body')
    dispose()
    expect((await ctx.skills.get('testenv-bootstrap'))?.provider).toBe('testenv-bootstrap')
  })

  it('disposing the plugin fiber withdraws the skill', async () => {
    const { ctx, fiber } = await bootSkills()
    expect((await ctx.skills.list()).some(entry => entry.name === 'testenv-bootstrap')).toBe(true)
    await fiber.dispose()
    expect((await ctx.skills.list()).some(entry => entry.name === 'testenv-bootstrap')).toBe(false)
  })
})
