/**
 * Artifact-contract policy on the `devflow/transition` waterfall: a configured
 * edge requires registered artifact kinds, and the newest registration of each
 * required kind must pass a mechanical structure check — the configured
 * frontmatter fields present and the configured `## ` section titles found. A
 * veto lists every defect at once, naming the kind, the file, and the missing
 * item, so one rework round sees the whole gap. Unconfigured edges delegate
 * without touching the store.
 *
 * The per-kind specs are also published as the read-only
 * `devflowArtifactSpecs` service, so a producer can shape a deliverable to the
 * same spec this gate checks instead of restating it.
 * @module @zhchxiao123/dsh-devflow-artifact-gate
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isCardLocation } from '@zhchxiao123/dsh-devflow'
import type { DevCard, TransitionAttempt, TransitionDecision } from '@zhchxiao123/dsh-devflow'
import { parse as parseYaml } from 'yaml'
import type { ArtifactKindSpec, ArtifactSpecs } from './types.ts'

export type { ArtifactKindSpec, ArtifactSpecs } from './types.ts'

export const name = 'devflow-artifact-gate'
export const inject = ['devflow']

/** Artifact-contract configuration; edge keys use the `from->to` form, e.g. `designing->ready`. */
export interface Config {
  /**
   * Structure spec per artifact kind: the single definition this gate checks
   * against and the `devflowArtifactSpecs` service publishes. A kind no edge
   * references is legal — it then exists only as published spec.
   */
  specs?: Record<string, ArtifactKindSpec>
  /** Artifact kinds each `from->to` edge requires; an edge with no entry is not gated. */
  edges?: Record<string, string[]>
}

/** Schemastery validator supplying the contract defaults. */
export const Config: z<Config> = z.object({
  specs: z.dict(z.object({
    frontmatter: z.array(z.string()),
    sections: z.array(z.string()),
  })).default({}),
  edges: z.dict(z.array(z.string())).default({}),
})

/**
 * Kind grammar, restated from the seam's store-written artifact registration
 * (`ARTIFACT_KIND` in `@zhchxiao123/dsh-devflow-filesystem`): lowercase
 * letters, digits, and dashes, starting alphanumeric. A divergence from the
 * original is a defect in this copy.
 */
const ARTIFACT_KIND = /^[a-z0-9][a-z0-9-]*$/

/** One kind's spec with the omitted-or-empty lists settled to empty. */
interface CheckedSpec {
  frontmatter: readonly string[]
  sections: readonly string[]
}

/** One edge requirement, its spec resolved at load so a lookup cannot miss. */
interface Requirement {
  kind: string
  spec: CheckedSpec
}

/**
 * Register the kind-spec service and the contract listener on the transition
 * waterfall.
 * @param ctx - registrant context carrying the devflow store, whose executor
 *   dispatches the guarded waterfall.
 * @param config - deployment contract definitions; an invalid edge key, an
 *   ill-formed kind, or an edge requiring an undeclared kind fails the load.
 */
export function apply(ctx: Context, config: Config): void {
  const specs = validatedSpecs(config.specs ?? {})
  const edges = validatedEdges(config.edges ?? {}, specs)
  ctx.effect(
    () => ctx.provide('devflowArtifactSpecs', publishedSpecs(specs)),
    'devflow-artifact-gate: kind-spec service',
  )
  ctx.effect(() => ctx.on(
    'devflow/transition',
    async (attempt: TransitionAttempt, next: () => Promise<TransitionDecision>): Promise<TransitionDecision> => {
      const required = edges[`${attempt.from}->${attempt.to}`]
      if (required === undefined) return await next()
      // Read-only on purpose: the store serializes per card, and this
      // waterfall runs inside the very transition holding that card's turn,
      // so any store write here would wait for a transition waiting for it.
      const card = await ctx.devflow.read(attempt.id, attempt.root)
      const defects: string[] = []
      for (const requirement of required) {
        defects.push(...await checkRequirement(card, requirement))
      }
      if (defects.length === 0) return await next()
      return {
        allowed: false,
        reason: `required artifacts are missing or malformed: ${defects.join('; ')}`,
      }
    },
  ), 'devflow-artifact-gate: artifact contract fence')
}

/**
 * Validate the configured specs: kind keys follow the seam's kind grammar and
 * every listed field or title is a non-empty string.
 * @param specs - the raw `specs` config section.
 * @returns the specs with omitted lists settled to empty.
 * @throws {Error} naming the offending config item.
 */
function validatedSpecs(specs: Record<string, ArtifactKindSpec>): Record<string, CheckedSpec> {
  const checked: Record<string, CheckedSpec> = {}
  for (const [kind, spec] of Object.entries(specs)) {
    if (!ARTIFACT_KIND.test(kind)) {
      throw new Error(`devflow-artifact-gate: specs names invalid kind ${JSON.stringify(kind)}; a kind is lowercase letters, digits, and dashes, starting alphanumeric`)
    }
    checked[kind] = {
      frontmatter: validatedList(spec.frontmatter, `specs["${kind}"].frontmatter`),
      sections: validatedList(spec.sections, `specs["${kind}"].sections`),
    }
  }
  return checked
}

/** Reject blank entries; an omitted list settles to empty. */
function validatedList(values: readonly string[] | undefined, owner: string): readonly string[] {
  if (values === undefined) return []
  for (const [index, value] of values.entries()) {
    if (value.trim().length === 0) {
      throw new Error(`devflow-artifact-gate: ${owner}[${index}] must be a non-empty string`)
    }
  }
  return [...values]
}

/**
 * Validate the configured edges and resolve each required kind to its spec.
 * An edge requiring nothing (an empty list) is dropped, so only edges with a
 * real requirement ever cost a card read.
 * @param edges - the raw `edges` config section.
 * @param specs - the validated specs the requirements must be declared in.
 * @returns requirements per edge key.
 * @throws {Error} naming the offending config item.
 */
function validatedEdges(
  edges: Record<string, string[]>,
  specs: Record<string, CheckedSpec>,
): Record<string, readonly Requirement[]> {
  const resolved: Record<string, readonly Requirement[]> = {}
  for (const [key, kinds] of Object.entries(edges)) {
    const parts = key.split('->')
    if (parts.length !== 2 || !isCardLocation(parts[0]) || !isCardLocation(parts[1])) {
      throw new Error(`devflow-artifact-gate: edges names invalid edge "${key}"; use "<from>-><to>" with stage names or "blocked"`)
    }
    const requirements = [...new Set(kinds)].map((kind): Requirement => {
      const spec = specs[kind]
      if (spec === undefined) {
        throw new Error(`devflow-artifact-gate: edges["${key}"] requires kind ${JSON.stringify(kind)}, which specs does not declare`)
      }
      return { kind, spec }
    })
    if (requirements.length > 0) resolved[key] = requirements
  }
  return resolved
}

/** The service value: the validated specs, normalized (empty lists dropped) and deep frozen. */
function publishedSpecs(specs: Record<string, CheckedSpec>): ArtifactSpecs {
  const published: Record<string, ArtifactKindSpec> = {}
  for (const [kind, spec] of Object.entries(specs)) {
    const value: ArtifactKindSpec = {
      ...spec.frontmatter.length > 0 ? { frontmatter: [...spec.frontmatter] } : {},
      ...spec.sections.length > 0 ? { sections: [...spec.sections] } : {},
    }
    Object.freeze(value.frontmatter)
    Object.freeze(value.sections)
    published[kind] = Object.freeze(value)
  }
  return Object.freeze(published)
}

/**
 * Check one required kind against the card: the newest registration of that
 * kind (the highest journal revision; path-only registrations carry no kind
 * and never match) must exist, be readable, and pass its structure spec.
 * @param card - the read value of the card being moved.
 * @param requirement - the required kind and its spec.
 * @returns the defects found, each naming the kind and what is wrong.
 */
async function checkRequirement(card: DevCard, requirement: Requirement): Promise<string[]> {
  const { kind, spec } = requirement
  // Records are in registration order and revisions only grow, so the last
  // record of a kind is the one with the highest revision.
  const newest = card.artifactRecords.filter(record => record.kind === kind).at(-1)
  if (newest === undefined) {
    return [`${kind}: no artifact of this kind is registered on card ${card.id}`]
  }
  // The record's path is journal-recorded relative to the card directory,
  // which the seam names as the card file's parent.
  let raw: string
  try {
    raw = await readFile(join(dirname(card.path), newest.path), 'utf8')
  } catch (error) {
    return [`${kind}: the registered artifact ${newest.path} cannot be read (${message(error)}); the journal references a file the disk does not serve`]
  }
  return structureDefects(kind, newest.path, raw, spec)
}

/** The structure checks of one artifact file; a clean file yields no defects. */
function structureDefects(kind: string, path: string, raw: string, spec: CheckedSpec): string[] {
  const defects: string[] = []
  const split = splitFrontmatter(raw)
  if (spec.frontmatter.length > 0) {
    if (split === undefined) {
      defects.push(`${kind}: ${path} has no YAML frontmatter block`)
    } else {
      defects.push(...frontmatterDefects(kind, path, split.yaml, spec.frontmatter))
    }
  }
  const content = split === undefined ? raw : split.body
  for (const title of spec.sections) {
    if (!content.split('\n').some(line => line.trimEnd() === `## ${title}`)) {
      defects.push(`${kind}: ${path} is missing section "## ${title}"`)
    }
  }
  return defects
}

/** The frontmatter field checks: parseable YAML mapping, each field present with a value. */
function frontmatterDefects(kind: string, path: string, yaml: string, fields: readonly string[]): string[] {
  let data: unknown
  try {
    data = parseYaml(yaml)
  } catch (error) {
    return [`${kind}: ${path} has invalid YAML frontmatter: ${message(error)}`]
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [`${kind}: ${path} frontmatter is not a YAML mapping`]
  }
  const mapping = data as Record<string, unknown>
  const defects: string[] = []
  for (const field of fields) {
    // A key mapped to nothing (`card:`) declares no value; it counts as missing.
    if (mapping[field] === undefined || mapping[field] === null) {
      defects.push(`${kind}: ${path} is missing frontmatter field "${field}"`)
    }
  }
  return defects
}

/** The text between the file's first `---` pair, and everything below it. */
function splitFrontmatter(raw: string): { yaml: string; body: string } | undefined {
  const lines = raw.split('\n')
  if (lines[0]?.trimEnd() !== '---') return undefined
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trimEnd() === '---') {
      return { yaml: lines.slice(1, index).join('\n'), body: lines.slice(index + 1).join('\n') }
    }
  }
  return undefined
}

function message(error: unknown): string {
  /* v8 ignore next -- readFile and yaml throw Error instances; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}
