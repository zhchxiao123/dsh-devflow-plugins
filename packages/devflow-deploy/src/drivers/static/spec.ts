/**
 * The manifest fields the static kind owns. The core hands this driver
 * everything it does not itself understand, so validating them — and reporting
 * each with its field path — belongs here.
 */

import { ManifestError } from '../../manifest.ts'

/** Default entry document; a site without one is almost always a build that did not run. */
export const DEFAULT_ENTRY = 'index.html'

/** One `kind: static` target after validation. */
export interface StaticSpec {
  /** Built artifact directory, relative to the workspace root. */
  readonly dir: string
  /** Document that must exist inside `dir` for the artifact to count as built. */
  readonly entry: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A relative path that stays inside its base once normalised. */
function escapesBase(value: string): boolean {
  if (value.startsWith('/')) return true
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  let depth = 0
  for (const segment of segments) {
    depth += segment === '..' ? -1 : 1
    if (depth < 0) return true
  }
  return false
}

/**
 * Validate one static target's fields.
 * @param spec - the target entry minus the fields the core owns.
 * @param path - field path of this target, for issue messages.
 * @returns the validated spec with defaults applied.
 * @throws {ManifestError} listing every field-path issue found.
 */
export function validateStaticSpec(spec: unknown, path: string): StaticSpec {
  const issues: string[] = []
  if (!isRecord(spec)) {
    throw new ManifestError(`${path} is invalid`, [`${path}: must be a mapping of target fields`])
  }

  const dir = spec['dir']
  if (typeof dir !== 'string' || dir.trim() === '') {
    issues.push(`${path}.dir: must name the built artifact directory, relative to the workspace root`)
  } else if (escapesBase(dir)) {
    issues.push(`${path}.dir: must stay inside the workspace; '${dir}' does not`)
  }

  const rawEntry = spec['entry']
  if (rawEntry !== undefined && (typeof rawEntry !== 'string' || rawEntry.trim() === '')) {
    issues.push(`${path}.entry: must name a document inside the artifact directory when present`)
  } else if (typeof rawEntry === 'string' && escapesBase(rawEntry)) {
    issues.push(`${path}.entry: must stay inside the artifact directory; '${rawEntry}' does not`)
  }

  if (issues.length > 0) throw new ManifestError(`${path} is invalid`, issues)
  return { dir: dir as string, entry: typeof rawEntry === 'string' ? rawEntry : DEFAULT_ENTRY }
}
