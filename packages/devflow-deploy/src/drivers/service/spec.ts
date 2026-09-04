/**
 * The manifest fields the service kind owns. A service target names the image
 * to build, the compose service to restart, and — crucially — how to tell that
 * the new container came up.
 *
 * `ready` is required. The kind promises that a deploy reporting success has a
 * healthy container behind it, and a target with no way to check that cannot
 * keep the promise, so its absence is a manifest defect rather than a skipped
 * step.
 */

import { ManifestError } from '../../manifest.ts'

/** How the driver decides that the new container is serving. */
export type ReadySpec
  = /** Poll an HTTP endpoint until it answers 2xx. */
    | { readonly kind: 'http'; readonly url: string }
    /** Poll a TCP port until it accepts a connection. */
    | { readonly kind: 'tcp'; readonly port: number }
    /** Poll the container's own `HEALTHCHECK` until Docker reports it healthy. */
    | { readonly kind: 'docker' }

/** One `kind: service` target after validation. */
export interface ServiceSpec {
  /** Image repository name; the driver appends the release identifier as the tag. */
  readonly image: string
  /** Build context directory, relative to the workspace root. */
  readonly context: string
  /** Dockerfile path, relative to the build context. */
  readonly dockerfile?: string
  /** Compose service name, used to restart and to inspect the container. */
  readonly service: string
  /** How to decide the new container is serving. */
  readonly ready: ReadySpec
}

/** Default build context; a repository root is where a Dockerfile usually sits. */
const DEFAULT_CONTEXT = '.'

/** The forms `ready` accepts; naming them keeps the unknown-form error honest. */
const READY_FORMS = ['http', 'tcp', 'docker'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A relative path that stays inside its base once normalised. */
function escapesBase(value: string): boolean {
  if (value.startsWith('/')) return true
  let depth = 0
  for (const segment of value.split('/').filter(part => part !== '' && part !== '.')) {
    depth += segment === '..' ? -1 : 1
    if (depth < 0) return true
  }
  return false
}

function readString(
  spec: Record<string, unknown>,
  field: string,
  path: string,
  issues: string[],
  what: string,
): string | undefined {
  const value = spec[field]
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${path}.${field}: must name ${what}`)
    return undefined
  }
  return value
}

/**
 * Validate the `ready` declaration.
 *
 * The form is a discriminant, and this union is merge-extensible — a future
 * kind of check joins it — so an unrecognised form falls through to a
 * documented default naming the forms that exist rather than crashing.
 */
function readReady(raw: unknown, path: string, issues: string[]): ReadySpec | undefined {
  if (!isRecord(raw)) {
    issues.push(
      `${path}.ready: required, and must declare one of ${READY_FORMS.join(', ')} — a deploy reports `
      + 'success only once the new container answers, so a target with no check cannot be deployed',
    )
    return undefined
  }
  const forms = READY_FORMS.filter(form => raw[form] !== undefined)
  if (forms.length !== 1) {
    issues.push(
      forms.length === 0
        ? `${path}.ready: unknown form; supported forms are ${READY_FORMS.join(', ')}`
        : `${path}.ready: declares ${forms.join(' and ')}; exactly one form is allowed`,
    )
    return undefined
  }
  const [form] = forms
  if (form === 'http') {
    const url = raw['http']
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url)) {
      issues.push(`${path}.ready.http: must be an absolute http(s) URL the deployment host can reach`)
      return undefined
    }
    return { kind: 'http', url }
  }
  if (form === 'tcp') {
    const port = raw['tcp']
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      issues.push(`${path}.ready.tcp: must be a port number between 1 and 65535`)
      return undefined
    }
    return { kind: 'tcp', port }
  }
  if (raw['docker'] !== 'health') {
    issues.push(`${path}.ready.docker: the only supported value is 'health', which polls the container's own HEALTHCHECK`)
    return undefined
  }
  return { kind: 'docker' }
}

/**
 * Validate one service target's fields.
 * @param spec - the target entry minus the fields the core owns.
 * @param path - field path of this target, for issue messages.
 * @returns the validated spec with defaults applied.
 * @throws {ManifestError} listing every field-path issue found.
 */
export function validateServiceSpec(spec: unknown, path: string): ServiceSpec {
  if (!isRecord(spec)) {
    throw new ManifestError(`${path} is invalid`, [`${path}: must be a mapping of target fields`])
  }
  const issues: string[] = []
  const image = readString(spec, 'image', path, issues, 'the image repository to build, without a tag')
  if (image !== undefined && /[:\s]/.test(image)) {
    issues.push(`${path}.image: must not carry a tag or whitespace; the driver tags each release itself`)
  }
  const service = readString(spec, 'service', path, issues, 'the compose service to restart')

  const rawContext = spec['context']
  let context = DEFAULT_CONTEXT
  if (rawContext !== undefined) {
    if (typeof rawContext !== 'string' || rawContext.trim() === '') {
      issues.push(`${path}.context: must name the build context directory when present`)
    } else if (escapesBase(rawContext)) {
      issues.push(`${path}.context: must stay inside the workspace; '${rawContext}' does not`)
    } else {
      context = rawContext
    }
  }

  const rawDockerfile = spec['dockerfile']
  if (rawDockerfile !== undefined) {
    if (typeof rawDockerfile !== 'string' || rawDockerfile.trim() === '') {
      issues.push(`${path}.dockerfile: must name a Dockerfile inside the build context when present`)
    } else if (escapesBase(rawDockerfile)) {
      issues.push(`${path}.dockerfile: must stay inside the build context; '${rawDockerfile}' does not`)
    }
  }

  const ready = readReady(spec['ready'], path, issues)

  if (issues.length > 0) throw new ManifestError(`${path} is invalid`, issues)
  return {
    image: image as string,
    context,
    ...typeof rawDockerfile === 'string' ? { dockerfile: rawDockerfile } : {},
    service: service as string,
    ready: ready as ReadySpec,
  }
}
