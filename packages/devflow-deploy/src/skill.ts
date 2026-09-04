/**
 * Bundled skill provider — the judgment half of the deploy capability. The
 * tools execute a manifest; the skill owns producing one, deciding when a
 * target is fit to publish, and reading a failure well enough to choose
 * between fixing forward and rolling back. Registered at
 * `BUNDLED_SKILL_RANK`, so a same-layer provider with a lower rank overrides
 * it by name.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'deploy-bootstrap'

// `../assets/` resolves from `src/` in tests and from the bundled `lib/` entry
// in the published package alike; the assets directory ships in `files`.
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const

const DESCRIPTION
  = 'Research what this project publishes and write or repair its deploy.yml manifest, then verify a '
    + 'target before and after publishing it. Use when asked to deploy, publish, or release something, '
    + 'when deploy_target, deploy_status, or deploy_rollback report a missing or invalid deploy.yml, or '
    + 'when a deploy fails and the choice is between fixing forward and rolling back.'

const CANDIDATE: SkillCandidate = {
  name: PROVIDER_NAME,
  description: DESCRIPTION,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: new URL(`../assets/${PROVIDER_NAME}.md`, import.meta.url),
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(won: SkillCandidate): Promise<SkillDefinition> {
    return {
      name: won.name,
      description: won.description,
      invocation: won.invocation,
      provider: won.provider,
      source: won.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(won.locator as URL, 'utf8'),
    }
  },
}

/**
 * Register the bundled `deploy-bootstrap` provider on `ctx.skills`. The
 * registry files the registration as an effect of the calling fiber, so
 * disposing the plugin unregisters the skill with it.
 * @param ctx - registrant context carrying the skill registry.
 */
export function registerSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
