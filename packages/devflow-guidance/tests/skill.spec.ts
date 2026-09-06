/**
 * The function-plugin export surface and the bundled skill provider against a
 * real skill registry: the advertised catalog entry (invocation policy, a
 * description that fits the harness's 500-character catalog cap as complete
 * sentences), the loaded body read from the shipped asset, and removal on
 * fiber disposal.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Guidance from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function bootSkills(): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  // The board seam is inert here: this suite exercises the skill layer, and
  // the store is never read before a pre-step names a workspace.
  ctx.provide('devflow', { list: () => Promise.resolve([]), holder: () => Promise.resolve(undefined) })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(Guidance, {})
  return { ctx, fiber }
}

describe('plugin export surface', () => {
  it('exposes the function-plugin shape with no default export and no tunables', () => {
    expect(Guidance.name).toBe('devflow-guidance')
    expect(Guidance.inject).toEqual(['devflow', 'skills', 'systemPrompt'])
    expect(typeof Guidance.apply).toBe('function')
    expect('default' in Guidance).toBe(false)
    expect(Guidance.Config({})).toEqual({})
  })
})

describe('the bundled devflow-workflow skill', () => {
  it('advertises one model- and user-invocable bundled skill with the shipped assets directory', async () => {
    const { ctx } = await bootSkills()
    const summary = (await ctx.skills.list()).find(entry => entry.name === 'devflow-workflow')
    expect(summary).toBeDefined()
    expect(summary?.provider).toBe('devflow-workflow')
    expect(summary?.source).toBe('bundled')
    expect(summary?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(summary?.resourceBase?.kind).toBe('directory')
    if (summary?.resourceBase?.kind === 'directory') {
      expect(summary.resourceBase.path).toContain(join('devflow-guidance', 'assets'))
    }
  })

  it('fits the catalog cap with complete sentences naming the three trigger scenarios', async () => {
    const { ctx } = await bootSkills()
    const description = (await ctx.skills.list()).find(entry => entry.name === 'devflow-workflow')?.description ?? ''
    // The harness catalog truncates at 500 normalized characters; a description
    // under the cap appears whole, so the cap is this package's contract.
    expect(description.replace(/\s+/g, ' ').trim().length).toBeLessThanOrEqual(500)
    expect(description.endsWith('.')).toBe(true)
    expect(description).toContain('turn a discussed plan or requirement into tracked work')
    expect(description).toContain('devflow_transition is vetoed')
    expect(description).toContain('active devflow board')
  })

  it('loads the six-section judgment body from the shipped assets file', async () => {
    const { ctx } = await bootSkills()
    const skill = await ctx.skills.get('devflow-workflow')
    expect(skill).toBeDefined()
    expect(skill?.content).toBe(
      await readFile(new URL('../assets/devflow-workflow.md', import.meta.url), 'utf8'),
    )
    expect(skill?.content).toContain('## 1. Whether to touch the board')
    expect(skill?.content).toContain('## 2. Service class')
    expect(skill?.content).toContain('## 3. Decomposing a requirement')
    expect(skill?.content).toContain('## 4. Artifacts')
    expect(skill?.content).toContain('## 5. After a veto')
    expect(skill?.content).toContain('## 6. Claims and leases')
  })

  it('pins the body contract sentences', async () => {
    const { ctx } = await bootSkills()
    const body = (await ctx.skills.get('devflow-workflow'))?.content ?? ''
    // The judgment/obligation boundary: per-call protocol stays with the tools.
    expect(body).toContain('nothing here repeats them')
    // Deployment artifact requirements come from the tool results, never from
    // this static body — the sentence that keeps the skill true everywhere.
    expect(body).toContain('**That preflight is the authority**')
    // Rework etiquette: revise the same kind; an unchanged retry buys nothing.
    expect(body).toContain('register a revised artifact of the **same kind**')
    expect(body).toContain('reuses the cached verdict')
    // The emergency shortcut records no debt; the follow-up card is on the model.
    expect(body).toContain('is an ordinary card you create yourself')
    // Lease etiquette: takeover is the human plane's call.
    expect(body).toContain('not a call you make')
  })

  it('disposing the plugin fiber withdraws the skill', async () => {
    const { ctx, fiber } = await bootSkills()
    expect((await ctx.skills.list()).some(entry => entry.name === 'devflow-workflow')).toBe(true)
    await fiber.dispose()
    expect((await ctx.skills.list()).some(entry => entry.name === 'devflow-workflow')).toBe(false)
  })
})
