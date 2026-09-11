/**
 * Bundled skill provider — the judgment half of the testenv capability. The
 * tools execute a manifest; two skills own producing one. `testenv-bootstrap`
 * surveys the project's whole test landscape (CI configuration first), traces
 * each suite's service binding, writes `testenv.yml` with selection and
 * provenance recorded in its header comment, proves it with the positive loop
 * plus a red run against the environment torn down, and repairs it when it
 * rots. `testenv-author` covers the project bootstrap cannot serve — no
 * service-bound suite exists — by deriving an integration-test plan from code
 * evidence and, only after the user approves the plan, writing the suite
 * bootstrap then selects. Both are registered at `BUNDLED_SKILL_RANK`, so a
 * same-layer provider with a lower rank overrides either by name.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'testenv-bootstrap'

// `../assets/` resolves from `src/` in tests and from the bundled `lib/` entry
// in the published package alike; the assets directory ships in `files`.
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const BOOTSTRAP_DESCRIPTION
  = 'Research how this project\'s test environment starts and write or repair its '
    + 'testenv.yml manifest. Use when asked how the test environment or its services start, '
    + 'when env_up, env_status, env_logs, env_down, or env_test report a missing or invalid '
    + 'manifest, or when a service declared in an existing manifest fails to start or to probe ready.'

const AUTHOR_DESCRIPTION
  = 'Derive an integration-test plan from code evidence and, once the user approves it, write the '
    + 'project\'s first service-bound integration tests. Use when the testenv-bootstrap survey '
    + 'eliminates every candidate suite, when asked to write or add integration tests to a project '
    + 'that has none, or when a project needs a service-bound suite before testenv.yml can name one.'

function candidate(name: string, description: string): SkillCandidate {
  return {
    name,
    description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL(`../assets/${name}.md`, import.meta.url),
  }
}

const CANDIDATES: readonly SkillCandidate[] = [
  candidate('testenv-bootstrap', BOOTSTRAP_DESCRIPTION),
  candidate('testenv-author', AUTHOR_DESCRIPTION),
]

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(CANDIDATES),
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
 * Register the bundled `testenv-bootstrap` provider — carrying both bundled
 * skills — on `ctx.skills`. The registry files the registration as an effect
 * of the calling fiber, so disposing the plugin unregisters both skills with
 * it.
 * @param ctx - registrant context carrying the skill registry.
 */
export function registerSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
