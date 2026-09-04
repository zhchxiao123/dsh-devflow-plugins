/**
 * The `deploy.yml` loader and the half of its validation the core owns. A
 * target declares a `kind` and an optional `build` pre-step; every other field
 * is that kind's private vocabulary and reaches its driver untouched. The core
 * knowing a driver's fields would make adding a kind a change here, which is
 * exactly what the seam exists to prevent.
 *
 * The file is a durable boundary, so it is validated whole: every issue is
 * reported with its field path rather than the first one aborting the load.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import type { DeployManifest, ManifestTarget } from './types.ts'

/** Default manifest name, relative to the workspace root. */
export const MANIFEST_FILENAME = 'deploy.yml'

/**
 * Admissible target names. A target name reaches remote paths and public URLs,
 * so its character set is a security invariant rather than a deployment-varying
 * choice: it stays fixed here instead of becoming a `Config` field.
 */
export const TARGET_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** The fields the core owns; everything else belongs to the driver. */
const CORE_FIELDS = new Set(['kind', 'build'])

/** A manifest that is missing, unreadable, or invalid, with every field-path issue found. */
export class ManifestError extends Error {
  /** Field-path issues, in document order. */
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length === 0 ? message : `${message}\n${issues.map(issue => `  - ${issue}`).join('\n')}`)
    this.name = 'ManifestError'
    this.issues = issues
  }
}

function message(error: unknown): string {
  /* v8 ignore next -- readFile and yaml throw Error instances; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTarget(
  name: string,
  raw: unknown,
  issues: string[],
): ManifestTarget | undefined {
  const path = `targets.${name}`
  if (!isRecord(raw)) {
    issues.push(`${path}: must be a mapping of target fields`)
    return undefined
  }
  const kind = raw['kind']
  if (typeof kind !== 'string' || kind === '') {
    issues.push(`${path}.kind: must be a non-empty string naming a registered target kind`)
    return undefined
  }
  const build = raw['build']
  if (build !== undefined && (typeof build !== 'string' || build.trim() === '')) {
    issues.push(`${path}.build: must be a non-empty command string when present`)
    return undefined
  }
  const spec: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!CORE_FIELDS.has(key)) spec[key] = value
  }
  return { kind, ...build === undefined ? {} : { build }, spec }
}

/**
 * Parse a manifest document.
 * @param source - the file's text.
 * @param origin - path reported in messages.
 * @returns the parsed manifest; driver-owned fields are not yet validated.
 * @throws {ManifestError} listing every field-path issue found.
 */
export function parseManifest(source: string, origin: string): DeployManifest {
  let document: unknown
  try {
    document = parse(source)
  } catch (error) {
    throw new ManifestError(`${origin} is not valid YAML: ${message(error)}`)
  }
  if (document === null || document === undefined) {
    throw new ManifestError(`${origin} is empty; it must declare at least one target under 'targets'`)
  }
  if (!isRecord(document)) {
    throw new ManifestError(`${origin} must be a mapping with a 'targets' key`)
  }
  const rawTargets = document['targets']
  if (!isRecord(rawTargets)) {
    throw new ManifestError(`${origin}: 'targets' must be a mapping of target name to target fields`)
  }
  const names = Object.keys(rawTargets)
  if (names.length === 0) {
    throw new ManifestError(`${origin}: 'targets' declares no targets`)
  }

  const issues: string[] = []
  const targets = new Map<string, ManifestTarget>()
  for (const name of names) {
    if (!TARGET_NAME_PATTERN.test(name)) {
      issues.push(
        `targets.${name}: target names reach remote paths and public URLs, so they must be `
        + 'lowercase letters, digits, and inner hyphens only',
      )
      continue
    }
    const target = readTarget(name, rawTargets[name], issues)
    if (target !== undefined) targets.set(name, target)
  }
  if (issues.length > 0) throw new ManifestError(`${origin} is invalid`, issues)
  return { targets }
}

/**
 * Load and parse the workspace's manifest.
 * @param root - absolute workspace root.
 * @param manifestPath - manifest path relative to the root.
 * @returns the parsed manifest.
 * @throws {ManifestError} when the file is missing, unreadable, or invalid.
 */
export async function loadManifest(root: string, manifestPath: string): Promise<DeployManifest> {
  const origin = resolve(root, manifestPath)
  let source: string
  try {
    source = await readFile(origin, 'utf8')
  } catch (error) {
    throw new ManifestError(`${origin} could not be read: ${message(error)}`)
  }
  return parseManifest(source, origin)
}

/**
 * Look one target up by name.
 * @param manifest - the parsed manifest.
 * @param name - the requested target name.
 * @returns the declared target.
 * @throws {ManifestError} naming every declared target.
 */
export function requireTarget(manifest: DeployManifest, name: string): ManifestTarget {
  const target = manifest.targets.get(name)
  if (target !== undefined) return target
  throw new ManifestError(
    `no target named '${name}' is declared; declared targets: ${[...manifest.targets.keys()].join(', ')}`,
  )
}
