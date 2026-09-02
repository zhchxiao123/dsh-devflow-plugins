/**
 * The bundled skill provider against a real skill registry: the advertised
 * catalog (`testenv-bootstrap` plus `testenv-author`), the loaded bodies
 * (read from the shipped assets), the bundled rank losing to a lower-ranked
 * same-layer rival, and removal on fiber disposal.
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

describe('the bundled testenv skills', () => {
  it('advertises two model- and user-invocable bundled skills with the shared assets directory', async () => {
    const { ctx } = await bootSkills()
    const summaries = await ctx.skills.list()
    for (const name of ['testenv-bootstrap', 'testenv-author']) {
      const summary = summaries.find(entry => entry.name === name)
      expect(summary).toBeDefined()
      expect(summary?.provider).toBe('testenv-bootstrap')
      expect(summary?.source).toBe('bundled')
      expect(summary?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(summary?.resourceBase?.kind).toBe('directory')
      if (summary?.resourceBase?.kind === 'directory') {
        expect(summary.resourceBase.path).toContain(join('devflow-testenv', 'assets'))
      }
    }
    const bootstrap = summaries.find(entry => entry.name === 'testenv-bootstrap')
    expect(bootstrap?.description).toContain('testenv.yml')
    expect(bootstrap?.description).toContain('env_up')
    const author = summaries.find(entry => entry.name === 'testenv-author')
    expect(author?.description).toContain('write')
    expect(author?.description).toContain('integration tests')
    expect(author?.description).toContain('eliminates every candidate')
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
    expect(body).toContain('A survey that eliminates every candidate writes no manifest.')
    expect(body).toContain('Do not synthesize fixture services')
    // The zero-candidate outcome suggests testenv-author; the user takes the step.
    expect(body).toContain('Suggest the `testenv-author` skill as the next step')
    expect(body).toContain('writes tests only after the user approves the plan')
    expect(body).toContain('leave taking that step to the user')
    expect(body).toContain('The run must turn red')
    expect(body).toContain('## 7. Report the survey')
    expect(body).toContain(
      'exactly one test configuration, one CI test job, and no workspace or monorepo structure',
    )
    // File discipline survives the rewrite verbatim.
    expect(body).toContain('The manifest is this skill\'s only persistent artifact.')
    expect(body).toContain('not something to bridge by writing a shim manifest where the tool looked')
  })

  it('loads the five-phase authoring protocol from the shipped assets file', async () => {
    const { ctx } = await bootSkills()
    const skill = await ctx.skills.get('testenv-author')
    expect(skill).toBeDefined()
    expect(skill?.content).toBe(
      await readFile(new URL('../assets/testenv-author.md', import.meta.url), 'utf8'),
    )
    expect(skill?.content).toContain('## 1. Survey the code')
    expect(skill?.content).toContain('## 2. Derive the plan from evidence')
    expect(skill?.content).toContain('## 3. The approval gate')
    expect(skill?.content).toContain('## 4. Write the tests, then prove them empirically')
    expect(skill?.content).toContain('## 5. Hand back to bootstrap')
    expect(skill?.content).toContain('## When no seam is worth an integration test')
  })

  it('pins the authoring protocol contract sentences', async () => {
    const { ctx } = await bootSkills()
    const body = (await ctx.skills.get('testenv-author'))?.content ?? ''
    // Two consent gates, named up front and never merged.
    expect(body).toContain(
      'invoked after the bootstrap survey eliminates every candidate, or when the user asks for '
      + 'integration tests to be written; the plan requires approval before any code is written',
    )
    expect(body).toContain('a bootstrap zero-candidate outcome never invokes this skill on its own')
    // Evidence discipline: no anchor, no plan entry.
    expect(body).toContain('A scenario without a code anchor does not enter the plan')
    // The approval gate is absolute.
    expect(body).toContain('Not one line of test code is written before the user approves the plan.')
    // An intent/behavior mismatch is a reported finding, never a quiet assertion.
    expect(body).toContain('never something to silently encode into an assertion')
    // Connectivity is the environment's proof, not the product's.
    expect(body).toContain('proves the environment is up, not that the product works')
    // The failure exit refuses fabricated seams.
    expect(body).toContain('Do not manufacture a seam to have tests to deliver')
    // The handoff keeps manifest ownership with bootstrap.
    expect(body).toContain('the manifest and its proof belong to bootstrap')
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
    // Override is by name: the sibling skill stays with the bundled provider.
    expect((await ctx.skills.get('testenv-author'))?.provider).toBe('testenv-bootstrap')
    dispose()
    expect((await ctx.skills.get('testenv-bootstrap'))?.provider).toBe('testenv-bootstrap')
  })

  it('disposing the plugin fiber withdraws both skills', async () => {
    const { ctx, fiber } = await bootSkills()
    const names = async (): Promise<string[]> => (await ctx.skills.list()).map(entry => entry.name)
    expect(await names()).toContain('testenv-bootstrap')
    expect(await names()).toContain('testenv-author')
    await fiber.dispose()
    expect(await names()).not.toContain('testenv-bootstrap')
    expect(await names()).not.toContain('testenv-author')
  })
})
