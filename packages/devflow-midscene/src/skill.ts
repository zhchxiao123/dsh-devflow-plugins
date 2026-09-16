/** The bundled procedure joining CLI evidence to existing Devflow tools. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'

const NAME = 'devflow-midscene-acceptance'
const ASSET = new URL('../assets/devflow-midscene-acceptance.md', import.meta.url)
const RESOURCE_BASE = { kind: 'directory', path: fileURLToPath(new URL('../assets/', import.meta.url)) } as const
const CANDIDATE: SkillCandidate = {
  name: NAME,
  description: 'Run repeatable Web acceptance with Playwright and Midscene. Prepare a versioned suite, '
    + 'observe and cancel its Harness shell job, inspect the report, register a Devflow test-report, '
    + 'and request the existing transition gates. Use for visual UI acceptance or investigating a failed Web flow.',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: ASSET,
}
const PROVIDER: SkillProvider = {
  name: NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(won) {
    return {
      name: won.name,
      description: won.description,
      invocation: won.invocation,
      provider: won.provider,
      source: won.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(ASSET, 'utf8'),
    }
  },
}

/**
 * Register one overridable, fiber-owned acceptance procedure.
 * @param ctx - context carrying the existing skill registry.
 */
export function registerSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => PROVIDER)
  const name = 'devflow-midscene-browser'
  const locator = new URL('../assets/devflow-midscene-browser.md', import.meta.url)
  const candidate: SkillCandidate = {
    ...CANDIDATE, name, provider: name, locator,
    description: 'Use the official Midscene CLI through managed jobs to observe, operate and visually check a configured Web page. Start with midscene_doctor. Exploration does not authorize Devflow completion.',
  }
  ctx.skills.registerProvider(() => ({
    name,
    list: () => Promise.resolve([candidate]),
    get: async won => ({
      name: won.name, description: won.description, invocation: won.invocation,
      provider: won.provider, source: won.source, resourceBase: RESOURCE_BASE,
      content: await readFile(locator, 'utf8'),
    }),
  }))
}
