/**
 * The function-plugin export surface and the bundled skill providers against
 * a real skill registry: the advertised catalog entries (invocation policy,
 * descriptions that fit the harness's 500-character catalog cap as complete
 * sentences), the loaded bodies read from the shipped assets, removal on
 * fiber disposal, and the `devflowSpec`-conditional registration of the
 * spec-authoring skill.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Guidance from '../src/index.ts'
import * as Skill from '../src/skill.ts'

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function bootSkills(options: { spec?: boolean } = {}): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  // The board seam is inert here: this suite exercises the skill layer, and
  // the store is never read before a pre-step names a workspace.
  ctx.provide('devflow', { list: () => Promise.resolve([]), holder: () => Promise.resolve(undefined) })
  // Existence is all the conditional registration reads; no method of the
  // spec store is ever called by this package.
  if (options.spec === true) ctx.provide('devflowSpec', {})
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

  it('exports only the two registration functions, never the bundled-skill factory', () => {
    expect(Object.keys(Skill).sort()).toEqual(['registerSkill', 'registerSpecAuthoringSkill'])
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

describe('the bundled devflow-spec-authoring skill', () => {
  it('does not register without the devflowSpec service while devflow-workflow still does', async () => {
    const { ctx } = await bootSkills()
    const names = (await ctx.skills.list()).map(entry => entry.name)
    expect(names).toContain('devflow-workflow')
    expect(names).not.toContain('devflow-spec-authoring')
  })

  it('advertises a model- and user-invocable bundled skill while devflowSpec is provided', async () => {
    const { ctx } = await bootSkills({ spec: true })
    const summary = (await ctx.skills.list()).find(entry => entry.name === 'devflow-spec-authoring')
    expect(summary).toBeDefined()
    expect(summary?.provider).toBe('devflow-spec-authoring')
    expect(summary?.source).toBe('bundled')
    expect(summary?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(summary?.resourceBase?.kind).toBe('directory')
    if (summary?.resourceBase?.kind === 'directory') {
      expect(summary.resourceBase.path).toContain(join('devflow-guidance', 'assets'))
    }
  })

  it('fits the catalog cap with complete sentences naming the four trigger scenarios', async () => {
    const { ctx } = await bootSkills({ spec: true })
    const description = (await ctx.skills.list()).find(entry => entry.name === 'devflow-spec-authoring')?.description ?? ''
    // The harness catalog truncates at 500 normalized characters; a description
    // under the cap appears whole, so the cap is this package's contract.
    expect(description.replace(/\s+/g, ' ').trim().length).toBeLessThanOrEqual(500)
    expect(description.endsWith('.')).toBe(true)
    expect(description).toContain('recording a learning worth keeping')
    expect(description).toContain('devflow_read_spec returns a stale warning')
    expect(description).toContain('devflow_write_spec rejects a write')
    expect(description).toContain('between a spec document and an iron rule')
  })

  it('loads the six-section judgment body from the shipped assets file', async () => {
    const { ctx } = await bootSkills({ spec: true })
    const skill = await ctx.skills.get('devflow-spec-authoring')
    expect(skill).toBeDefined()
    expect(skill?.content).toBe(
      await readFile(new URL('../assets/devflow-spec-authoring.md', import.meta.url), 'utf8'),
    )
    expect(skill?.content).toContain('## 1. What deserves a document')
    expect(skill?.content).toContain('## 2. Choosing anchors')
    expect(skill?.content).toContain('## 3. Scope and ids')
    expect(skill?.content).toContain('## 4. Revising and merging')
    expect(skill?.content).toContain('## 5. Responding to stale')
    expect(skill?.content).toContain('## 6. When not to write')
  })

  it('pins the body contract sentences', async () => {
    const { ctx } = await bootSkills({ spec: true })
    const body = (await ctx.skills.get('devflow-spec-authoring'))?.content ?? ''
    // The judgment/obligation boundary: the write protocol stays with the tools.
    expect(body).toContain('nothing here repeats either')
    // Anchor choice is a writability question before a strength question.
    expect(body).toContain('writability\nfirst')
    // The born-stale rule's consequence, verbatim commitment.
    expect(body).toContain('never that the document was wrong from the start')
    // Revision path: replaces revises; the tool description's wording is not a prohibition.
    expect(body).toContain('`replaces: [<own id>]` IS the revision path')
    expect(body).toContain('There is no delete operation')
    // The one silent failure worth a hazard line.
    expect(body).toContain('verify the index appears in the next card read')
    // Stale response discipline.
    expect(body).toContain('Never keep citing such a document as if it were fresh')
  })
})
