/**
 * Bundled skill provider — the judgment half of the devflow workflow. The
 * devflow tools commit individual moves and the gates enforce per-call
 * obligations; the skill owns the cross-tool process knowledge: entry
 * judgment, service-class selection, decomposition, artifact craft, rework
 * after a veto, and claim discipline. Registered at `BUNDLED_SKILL_RANK`, so
 * a same-layer provider with a lower rank overrides it by name.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'devflow-workflow'

// `../assets/` resolves from `src/` in tests and from the bundled `lib/` entry
// in the published package alike; the assets directory ships in `files`.
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const

const DESCRIPTION
  = 'Drive the devflow card workflow: decide when work belongs on the board, pick a service class, '
    + 'decompose an oversized requirement, write artifacts the gates can judge, and choose the rework '
    + 'path after a veto. Use when the user asks to turn a discussed plan or requirement into tracked '
    + 'work, when devflow_transition is vetoed and the next move must be chosen, or when starting work '
    + 'in a workspace that already has an active devflow board.'

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
 * Register the bundled `devflow-workflow` provider on `ctx.skills`. The
 * registry files the registration as an effect of the calling fiber, so
 * disposing the plugin unregisters the skill with it.
 * @param ctx - registrant context carrying the skill registry.
 */
export function registerSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
