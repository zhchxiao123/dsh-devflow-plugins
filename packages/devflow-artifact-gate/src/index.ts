/**
 * Artifact-contract policy on the `devflow/transition` waterfall: a configured
 * edge requires registered artifact kinds, and the newest registration of each
 * required kind must pass a mechanical structure check — the configured
 * frontmatter fields present and the configured `## ` section titles found. A
 * veto lists every defect at once, naming the kind, the file, and the missing
 * item, so one rework round sees the whole gap. Unconfigured edges delegate
 * without touching the store.
 *
 * The per-kind structures are also published as the read-only
 * `devflowArtifactStructures` service, so a producer can shape a deliverable to the
 * same structure this gate checks instead of restating it. The dynamic
 * `devflowArtifactContract` service inspects configured legal outgoing edges
 * with this same checker, so a model can see missing or malformed deliverables
 * before it attempts a transition.
 * @module @zhchxiao123/dsh-devflow-artifact-gate
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isCardLocation, isLegalTransition } from '@zhchxiao123/dsh-devflow'
import type { ArtifactContract, ArtifactRequirementInspection, ArtifactStructureEntry, ArtifactTransitionInspection, CardLocation, DevCard, PublishedArtifactKindStructure, TransitionAttempt, TransitionDecision } from '@zhchxiao123/dsh-devflow'
import { parse as parseYaml } from 'yaml'
import type { ArtifactKindStructure, ArtifactStructures } from './types.ts'

export type { ArtifactContract, ArtifactKindStructure, ArtifactRequirementInspection, ArtifactRequirementStatus, ArtifactSectionSpec, ArtifactStructureEntry, ArtifactStructures, ArtifactTransitionInspection, PublishedArtifactKindStructure } from './types.ts'

export const name = 'devflow-artifact-gate'
export const inject = ['devflow']

/** Artifact-contract configuration; edge keys use the `from->to` form, e.g. `designing->ready`. */
export interface Config {
  /**
   * Structure requirements per artifact kind: the single definition this gate checks
   * against and the `devflowArtifactStructures` service publishes. A kind no edge
   * references is legal — it then exists only as published structure.
   */
  kinds?: Record<string, ArtifactKindStructure>
  /** Artifact kinds each `from->to` edge requires; an edge with no entry is not gated. */
  edges?: Record<string, string[]>
}

/**
 * One list entry: a bare title, or a title with the guidance its author should
 * follow. The string member comes first so existing string-only configuration
 * matches without ever reaching the object member.
 *
 * This schema accepts an object missing either field — `z.object` treats its
 * properties as optional — so {@link validatedEntry} does the field-level
 * checking and reports which config item is at fault, which a union's
 * "no member matched" message could not.
 */
const StructureEntry = z.union([
  z.string(),
  z.object({ title: z.string(), description: z.string() }),
])

/** Schemastery validator supplying the contract defaults. */
export const Config: z<Config> = z.object({
  kinds: z.dict(z.object({
    frontmatter: z.array(StructureEntry),
    sections: z.array(StructureEntry),
    nonEmptySections: z.array(StructureEntry),
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

/**
 * One kind's structure with the omitted-or-empty lists settled to empty. Bare
 * titles only: the structure checks never see a description, so no wording of
 * one can move the line between a passing and a failing artifact.
 */
interface CheckedStructure {
  frontmatter: readonly string[]
  sections: readonly string[]
  nonEmptySections: readonly string[]
}

/** One kind's configured entries, kept verbatim for publication. */
interface PublishableStructure {
  frontmatter: readonly ArtifactStructureEntry[]
  sections: readonly ArtifactStructureEntry[]
  nonEmptySections: readonly ArtifactStructureEntry[]
}

/** One validated kind in both shapes: the titles this gate checks, the entries it publishes. */
interface ValidatedKind {
  checked: CheckedStructure
  publishable: PublishableStructure
}

/** One edge requirement, its structure resolved at load so a lookup cannot miss. */
interface Requirement {
  kind: string
  structure: CheckedStructure
}

/** Parsed edge retained after validation so consumers never reparse config keys. */
interface ValidatedEdge {
  from: CardLocation
  to: CardLocation
  requirements: readonly Requirement[]
}

/**
 * Register the kind-structure and inspection services plus the contract listener
 * on the transition waterfall.
 * @param ctx - registrant context carrying the devflow store, whose executor
 *   dispatches the guarded waterfall.
 * @param config - deployment contract definitions; an invalid edge key, an
 *   ill-formed kind, or an edge requiring an undeclared kind fails the load.
 */
export function apply(ctx: Context, config: Config): void {
  const kinds = validatedStructures(config.kinds ?? {})
  const edges = validatedEdges(config.edges ?? {}, kinds)
  const published = publishedStructures(kinds)
  ctx.effect(
    () => ctx.provide('devflowArtifactStructures', published),
    'devflow-artifact-gate: kind-structure service',
  )
  ctx.effect(
    () => ctx.provide('devflowArtifactContract', artifactContract(edges, published)),
    'devflow-artifact-gate: contract inspection service',
  )
  ctx.effect(() => ctx.on(
    'devflow/transition',
    async (attempt: TransitionAttempt, next: () => Promise<TransitionDecision>): Promise<TransitionDecision> => {
      const edge = edges[`${attempt.from}->${attempt.to}`]
      if (edge === undefined) return await next()
      // Read-only on purpose: the store serializes per card, and this
      // waterfall runs inside the very transition holding that card's turn,
      // so any store write here would wait for a transition waiting for it.
      const card = await ctx.devflow.read(attempt.id, attempt.root)
      const inspections = await Promise.all(edge.requirements.map(requirement =>
        inspectRequirement(card, requirement, requiredPublishedStructure(published, requirement.kind)),
      ))
      const defects = inspections.flatMap(inspection => inspection.defects)
      if (defects.length === 0) return await next()
      return {
        allowed: false,
        reason: `required artifacts are missing or malformed: ${defects.join('; ')}`,
      }
    },
  ), 'devflow-artifact-gate: artifact contract fence')
}

/** Build the immutable dynamic inspection seam over one validated contract. */
function artifactContract(
  edges: Readonly<Record<string, ValidatedEdge>>,
  kinds: ArtifactStructures,
): ArtifactContract {
  return Object.freeze({
    async inspectOutgoing(card: DevCard): Promise<readonly ArtifactTransitionInspection[]> {
      const outgoing: ArtifactTransitionInspection[] = []
      for (const edge of Object.values(edges)) {
        if (edge.from !== card.stage) continue
        if (!isLegalTransition(card.stage, edge.to, card)) continue
        const inspected = await Promise.all(edge.requirements.map(requirement =>
          inspectRequirement(card, requirement, requiredPublishedStructure(kinds, requirement.kind)),
        ))
        outgoing.push(Object.freeze({
          from: card.stage,
          to: edge.to,
          requirements: Object.freeze(inspected),
        }))
      }
      return Object.freeze(outgoing)
    },
  })
}

/**
 * Validate the configured kinds: kind keys follow the seam's kind grammar and
 * every listed field or title is a non-empty string, whether it is written bare
 * or as a `{ title, description }` entry.
 * @param kinds - the raw `kinds` config section.
 * @returns each kind in both shapes, with omitted lists settled to empty.
 * @throws {Error} naming the offending config item.
 */
function validatedStructures(kinds: Record<string, ArtifactKindStructure>): Record<string, ValidatedKind> {
  const validated: Record<string, ValidatedKind> = {}
  for (const [kind, structure] of Object.entries(kinds)) {
    if (!ARTIFACT_KIND.test(kind)) {
      throw new Error(`devflow-artifact-gate: kinds names invalid kind ${JSON.stringify(kind)}; a kind is lowercase letters, digits, and dashes, starting alphanumeric`)
    }
    const frontmatter = validatedList(structure.frontmatter, `kinds["${kind}"].frontmatter`)
    const sections = validatedList(structure.sections, `kinds["${kind}"].sections`)
    const nonEmptySections = validatedList(structure.nonEmptySections, `kinds["${kind}"].nonEmptySections`)
    validated[kind] = {
      checked: {
        frontmatter: frontmatter.map(titleOf),
        sections: sections.map(titleOf),
        nonEmptySections: nonEmptySections.map(titleOf),
      },
      publishable: { frontmatter, sections, nonEmptySections },
    }
  }
  return validated
}

/** Validate every entry of one list; an omitted list settles to empty. */
function validatedList(values: readonly ArtifactStructureEntry[] | undefined, owner: string): readonly ArtifactStructureEntry[] {
  if (values === undefined) return []
  return values.map((value, index) => validatedEntry(value, `${owner}[${index}]`))
}

/**
 * Validate one list entry. The schema's union admits an object missing either
 * field, so both are checked here and the failure names the exact config item.
 * @param value - the entry as the schema produced it, which is why it is read
 *   as `unknown`: the declared type promises more than the schema enforces.
 * @param owner - the entry's config path, e.g. `kinds["design"].sections[1]`.
 * @returns the entry, with an object entry reduced to just its two fields.
 * @throws {Error} naming the offending config item.
 */
function validatedEntry(value: unknown, owner: string): ArtifactStructureEntry {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new Error(`devflow-artifact-gate: ${owner} must be a non-empty string`)
    }
    return value
  }
  // A YAML list item written with no value at all parses to null.
  if (value === null) {
    throw new Error(`devflow-artifact-gate: ${owner} must be a non-empty string or a { title, description } entry`)
  }
  const { title, description } = value as { title?: unknown; description?: unknown }
  if (!isNonBlankString(title)) {
    throw new Error(`devflow-artifact-gate: ${owner}.title must be a non-empty string`)
  }
  if (!isNonBlankString(description)) {
    throw new Error(`devflow-artifact-gate: ${owner}.description must be a non-empty string`)
  }
  return { title, description }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** The title an entry names: the entry itself when bare, its `title` otherwise. */
function titleOf(entry: ArtifactStructureEntry): string {
  return typeof entry === 'string' ? entry : entry.title
}

/**
 * Validate the configured edges and resolve each required kind to its structure.
 * An edge requiring nothing (an empty list) is dropped, so only edges with a
 * real requirement ever cost a card read.
 * @param edges - the raw `edges` config section.
 * @param kinds - the validated kinds the requirements must be declared in.
 * @returns requirements per edge key.
 * @throws {Error} naming the offending config item.
 */
function validatedEdges(
  edges: Record<string, string[]>,
  declared: Record<string, ValidatedKind>,
): Record<string, ValidatedEdge> {
  const resolved: Record<string, ValidatedEdge> = {}
  for (const [key, required] of Object.entries(edges)) {
    const parts = key.split('->')
    if (parts.length !== 2 || !isCardLocation(parts[0]) || !isCardLocation(parts[1])) {
      throw new Error(`devflow-artifact-gate: edges names invalid edge "${key}"; use "<from>-><to>" with stage names or "blocked"`)
    }
    const requirements = [...new Set(required)].map((kind): Requirement => {
      const declaration = declared[kind]
      if (declaration === undefined) {
        throw new Error(`devflow-artifact-gate: edges["${key}"] requires kind ${JSON.stringify(kind)}, which kinds does not declare`)
      }
      return { kind, structure: declaration.checked }
    })
    if (requirements.length > 0) {
      resolved[key] = { from: parts[0], to: parts[1], requirements }
    }
  }
  return resolved
}

/** The service value: the validated kinds, normalized (empty lists dropped) and deep frozen. */
function publishedStructures(kinds: Record<string, ValidatedKind>): ArtifactStructures {
  const published: Record<string, ArtifactKindStructure> = {}
  for (const [kind, { publishable }] of Object.entries(kinds)) {
    const value: ArtifactKindStructure = {
      ...publishable.frontmatter.length > 0 ? { frontmatter: publishedList(publishable.frontmatter) } : {},
      ...publishable.sections.length > 0 ? { sections: publishedList(publishable.sections) } : {},
      ...publishable.nonEmptySections.length > 0 ? { nonEmptySections: publishedList(publishable.nonEmptySections) } : {},
    }
    Object.freeze(value.frontmatter)
    Object.freeze(value.sections)
    Object.freeze(value.nonEmptySections)
    published[kind] = Object.freeze(value)
  }
  return Object.freeze(published)
}

/** One list as the service hands it out: object entries copied, so the deep freeze reaches them. */
function publishedList(entries: readonly ArtifactStructureEntry[]): ArtifactStructureEntry[] {
  return entries.map(entry => typeof entry === 'string' ? entry : Object.freeze({ ...entry }))
}

/**
 * Check one required kind against the card: the newest registration of that
 * kind (the highest journal revision; path-only registrations carry no kind
 * and never match) must exist, be readable, and pass its structure requirements.
 * @param card - the read value of the card being moved.
 * @param requirement - the required kind and its structure.
 * @returns the defects found, each naming the kind and what is wrong.
 */
async function inspectRequirement(
  card: DevCard,
  requirement: Requirement,
  publishedStructure: PublishedArtifactKindStructure,
): Promise<ArtifactRequirementInspection> {
  const { kind, structure: checkedStructure } = requirement
  // Records are in registration order and revisions only grow, so the last
  // record of a kind is the one with the highest revision.
  const newest = card.artifactRecords.filter(record => record.kind === kind).at(-1)
  if (newest === undefined) {
    return inspected(kind, publishedStructure, undefined, [`${kind}: no artifact of this kind is registered on card ${card.id}`])
  }
  // The record's path is journal-recorded relative to the card directory,
  // which the seam names as the card file's parent.
  let raw: string
  try {
    raw = await readFile(join(dirname(card.path), newest.path), 'utf8')
  } catch (error) {
    return inspected(kind, publishedStructure, newest, [`${kind}: the registered artifact ${newest.path} cannot be read (${message(error)}); the journal references a file the disk does not serve`])
  }
  return inspected(kind, publishedStructure, newest, structureDefects(kind, newest.path, raw, checkedStructure))
}

/** A validated edge can only name a published kind; fail loudly if that invariant drifts. */
function requiredPublishedStructure(kinds: ArtifactStructures, kind: string): PublishedArtifactKindStructure {
  const structure = kinds[kind]
  /* v8 ignore next -- validatedEdges accepts only kinds resolved from this same published structure map. */
  if (structure === undefined) throw new Error(`devflow-artifact-gate: invariant violated: required kind ${JSON.stringify(kind)} has no published structure`)
  return structure
}

/** Freeze one public requirement result and derive its status from evidence. */
function inspected(
  kind: string,
  structure: PublishedArtifactKindStructure,
  artifact: DevCard['artifactRecords'][number] | undefined,
  defects: string[],
): ArtifactRequirementInspection {
  return Object.freeze({
    kind,
    status: artifact === undefined ? 'missing' : defects.length === 0 ? 'satisfied' : 'malformed',
    structure,
    ...artifact === undefined ? {} : { artifact: Object.freeze({ ...artifact }) },
    defects: Object.freeze(defects),
  })
}

/** The structure checks of one artifact file; a clean file yields no defects. */
function structureDefects(kind: string, path: string, raw: string, structure: CheckedStructure): string[] {
  const defects: string[] = []
  const split = splitFrontmatter(raw)
  if (structure.frontmatter.length > 0) {
    if (split === undefined) {
      defects.push(`${kind}: ${path} has no YAML frontmatter block`)
    } else {
      defects.push(...frontmatterDefects(kind, path, split.yaml, structure.frontmatter))
    }
  }
  const content = split === undefined ? raw : split.body
  const lines = content.split('\n')
  for (const title of structure.sections) {
    if (!lines.some(line => line.trimEnd() === `## ${title}`)) {
      defects.push(`${kind}: ${path} is missing section "## ${title}"`)
    }
  }
  for (const title of structure.nonEmptySections) {
    const heading = lines.findIndex(line => line.trimEnd() === `## ${title}`)
    if (heading < 0) {
      defects.push(`${kind}: ${path} is missing section "## ${title}"`)
      continue
    }
    if (!hasContent(lines, heading)) {
      defects.push(`${kind}: ${path} section "## ${title}" is empty`)
    }
  }
  return defects
}

/**
 * Whether a section carries anything before the next heading.
 * @param lines - the artifact body's lines.
 * @param heading - index of the section's own heading line.
 * @returns `true` once a non-blank line appears before the next heading.
 */
function hasContent(lines: readonly string[], heading: number): boolean {
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith('#')) return false
    if (line.trim().length > 0) return true
  }
  return false
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
