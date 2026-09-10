/**
 * Bundled skill providers — the judgment half of the devflow surfaces. The
 * devflow tools commit individual moves and the gates and stores enforce
 * per-call obligations; each skill owns the cross-tool judgment no single
 * tool description can. `devflow-workflow` carries the board process: entry
 * judgment, service-class selection, decomposition, artifact craft, rework
 * after a veto, and claim discipline. `devflow-spec-authoring` carries the
 * architecture-document judgment: what deserves a document, anchor choice,
 * scoping, revision, and the response to staleness. Both register at
 * `BUNDLED_SKILL_RANK`, so a same-layer provider with a lower rank overrides
 * either by name.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'

// `../assets/` resolves from `src/` in tests and from the bundled `lib/` entry
// in the published package alike; the assets directory ships in `files`.
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const

/**
 * One bundled skill: a single candidate named after its provider, body read
 * from the shipped `assets/<name>.md`. Package-internal on purpose — the two
 * bundled skills are this package's whole catalog surface, and a deployment
 * customizes by overriding a name with a lower-ranked provider, not by
 * minting new bundled skills from outside.
 * @param name - the skill, provider, and asset-file name.
 * @param description - the catalog description; must fit the harness's
 * 500-character catalog cap as complete sentences.
 * @returns the provider serving exactly that one skill.
 */
function bundledSkill(name: string, description: string): SkillProvider {
  const candidate: SkillCandidate = {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL(`../assets/${name}.md`, import.meta.url),
  }
  return {
    name,
    list: () => Promise.resolve([candidate]),
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
}

const WORKFLOW = bundledSkill(
  'devflow-workflow',
  'Drive the devflow card workflow: decide when work belongs on the board, pick a service class, '
  + 'decompose an oversized requirement, write artifacts the gates can judge, choose the rework path '
  + 'after a veto, and tell parking a card from dropping it. Use when the user asks to turn a '
  + 'discussed plan or requirement into tracked work, when devflow_transition is vetoed and the next '
  + 'move must be chosen, when a card should stop, or when starting work in a workspace that already '
  + 'has an active devflow board.',
)

const SPEC_AUTHORING = bundledSkill(
  'devflow-spec-authoring',
  'Author devflow architecture documents: decide what deserves a spec document versus an iron rule, '
  + 'choose anchors that are writable and falsifiable, scope ids so documents are found, and revise '
  + 'or merge through replaces. Use when recording a learning worth keeping beyond the current task, '
  + 'when devflow_read_spec returns a stale warning, when devflow_write_spec rejects a write, or '
  + 'when choosing between a spec document and an iron rule.',
)

/**
 * Register the bundled `devflow-workflow` provider on `ctx.skills`. The
 * registry files the registration as an effect of the calling fiber, so
 * disposing the plugin unregisters the skill with it.
 * @param ctx - registrant context carrying the skill registry.
 */
export function registerSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => WORKFLOW)
}

/**
 * Register the bundled `devflow-spec-authoring` provider on `ctx.skills`.
 * Same disposal contract as {@link registerSkill}; the caller decides the
 * owning fiber, which is how the skill mounts and unmounts with the
 * `devflowSpec` seam.
 * @param ctx - registrant context carrying the skill registry.
 */
export function registerSpecAuthoringSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => SPEC_AUTHORING)
}
