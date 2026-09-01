/**
 * Bundled `testenv-bootstrap` skill provider — the judgment half of the
 * testenv capability. The tools execute a manifest; this skill owns producing
 * one: researching how the project's services start (CI configuration first),
 * writing `testenv.yml`, proving it with the env_up → env_status → env_down
 * loop, and repairing it when it rots. Registered at `BUNDLED_SKILL_RANK`, so
 * a same-layer provider with a lower rank overrides it by name.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'testenv-bootstrap'

// `../assets/` resolves from `src/` in tests and from the bundled `lib/` entry
// in the published package alike; the assets directory ships in `files`.
const SKILL_BODY_URL = new URL('../assets/testenv-bootstrap.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION
  = 'Research how this project\'s integration-test environment starts and write or repair its '
    + 'testenv.yml manifest. Use when asked how the integration environment or its services start, '
    + 'when env_up, env_status, env_logs, env_down, or integration_test report a missing or invalid '
    + 'manifest, or when a service declared in an existing manifest fails to start or to probe ready.'

const CANDIDATE: SkillCandidate = {
  name: PROVIDER_NAME,
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/**
 * Register the bundled `testenv-bootstrap` provider on `ctx.skills`. The
 * registry files the registration as an effect of the calling fiber, so
 * disposing the plugin unregisters the skill with it.
 * @param ctx - registrant context carrying the skill registry.
 */
export function registerSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
