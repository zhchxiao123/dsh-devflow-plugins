/**
 * Validation for the composition-supplied {@link Config}. A gate that vetoes
 * moves must not guess at its own policy, so every field fails loud at load:
 * an unknown stage, an unknown assessment kind, or a warn edge carrying
 * enforce-only fields is a boot failure rather than a rule that quietly never
 * fires or fires wrong.
 * @module @zhchxiao123/dsh-devflow-jev-gate/config
 */

import { ASSESSMENT_KINDS } from '@zhchxiao123/dsh-devflow-jev'
import type { AssessmentKind } from '@zhchxiao123/dsh-devflow-jev'
import type { CardLocation } from '@zhchxiao123/dsh-devflow'
import type { Config, EdgePolicy, VetoConditions } from './types.ts'

/**
 * Restatement of the card locations `@zhchxiao123/dsh-devflow` admits; the
 * `satisfies` clause turns a divergence from the seam's union into a compile
 * error here rather than an edge that never matches.
 */
const LOCATIONS = Object.keys({
  draft: 0, designing: 0, developing: 0, reviewing: 0, ready: 0, testing: 0, done: 0, blocked: 0,
} satisfies Record<CardLocation, 0>)

function fail(index: number, message: string): never {
  throw new Error(`devflow-jev-gate: edges[${String(index)}] ${message}`)
}

function assertEdge(index: number, edge: unknown): string {
  if (typeof edge !== 'string') fail(index, 'needs an edge of the form "from->to"')
  const parts = edge.split('->')
  if (parts.length !== 2 || !parts.every(part => LOCATIONS.includes(part))) {
    fail(index, `has edge ${JSON.stringify(edge)}; expected "from->to" between ${LOCATIONS.join(', ')}`)
  }
  return edge
}

function assertKinds(index: number, kinds: unknown): readonly AssessmentKind[] {
  if (!Array.isArray(kinds) || kinds.length === 0) fail(index, 'needs at least one assessment kind')
  for (const kind of kinds) {
    if (!ASSESSMENT_KINDS.includes(kind as AssessmentKind)) {
      fail(index, `has unknown assessment kind ${JSON.stringify(kind)}; expected one of ${ASSESSMENT_KINDS.join(', ')}`)
    }
  }
  if (new Set(kinds).size !== kinds.length) fail(index, 'repeats an assessment kind')
  return kinds as readonly AssessmentKind[]
}

/** Bounds carry the answer's own scale: probability mass in (0,1], a score on the rubric's 0–4 levels. */
function assertVeto(index: number, veto: unknown, kinds: readonly AssessmentKind[]): VetoConditions {
  if (veto === null || typeof veto !== 'object') fail(index, 'is an enforce edge and needs a veto object with at least one condition')
  const { releaseBlockedMass, riskScore, riskConfidence, ...rest } = veto as Record<string, unknown>
  if (Object.keys(rest).length > 0) fail(index, `has unknown veto conditions: ${Object.keys(rest).join(', ')}`)
  if (riskConfidence !== undefined && riskScore === undefined) fail(index, 'sets veto.riskConfidence without veto.riskScore')
  if (releaseBlockedMass === undefined && riskScore === undefined) fail(index, 'needs at least one veto condition')
  if (releaseBlockedMass !== undefined) {
    if (typeof releaseBlockedMass !== 'number' || !(releaseBlockedMass > 0) || releaseBlockedMass > 1) fail(index, 'needs veto.releaseBlockedMass in (0, 1]')
    if (!kinds.includes('release-readiness')) fail(index, 'vetoes on releaseBlockedMass but does not run the release-readiness assessment')
  }
  if (riskScore !== undefined) {
    if (typeof riskScore !== 'number' || !(riskScore > 0) || riskScore > 4) fail(index, 'needs veto.riskScore in (0, 4]')
    if (!kinds.includes('implementation-risk')) fail(index, 'vetoes on riskScore but does not run the implementation-risk assessment')
  }
  if (riskConfidence !== undefined && (typeof riskConfidence !== 'number' || riskConfidence < 0 || riskConfidence > 1)) {
    fail(index, 'needs veto.riskConfidence in [0, 1]')
  }
  return { releaseBlockedMass, riskScore, riskConfidence } as VetoConditions
}

function assertPolicy(index: number, policy: unknown): EdgePolicy {
  if (policy === null || typeof policy !== 'object') fail(index, 'must be an object')
  const { edge, kinds, mode, timeoutMs, failClosed, veto } = policy as Record<string, unknown>
  const parsedEdge = assertEdge(index, edge)
  const parsedKinds = assertKinds(index, kinds)
  if (mode !== 'warn' && mode !== 'enforce') fail(index, 'needs mode "warn" or "enforce"')
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail(index, 'needs a positive finite timeoutMs')
  if (mode === 'warn') {
    // Enforce-only fields on a warn edge would be surface nothing reads — and
    // a reader believing they took effect.
    if (failClosed !== undefined || veto !== undefined) fail(index, 'is a warn edge; failClosed and veto belong to enforce edges only')
    return { edge: parsedEdge, kinds: parsedKinds, mode, timeoutMs }
  }
  if (typeof failClosed !== 'boolean') fail(index, 'is an enforce edge and needs an explicit failClosed decision')
  return { edge: parsedEdge, kinds: parsedKinds, mode, timeoutMs, failClosed, veto: assertVeto(index, veto, parsedKinds) }
}

/**
 * Validate the composition-supplied configuration.
 *
 * @param config - the candidate configuration.
 * @returns the validated edge policies.
 * @throws Error naming the offending edge and rule.
 */
export function assertConfig(config: unknown): readonly EdgePolicy[] {
  const edges = (config as Config | null)?.edges
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error('devflow-jev-gate: config.edges must list at least one guarded edge; mounting an inert gate hides a broken composition')
  }
  const policies = edges.map((policy, index) => assertPolicy(index, policy))
  const seen = new Set<string>()
  for (const [index, policy] of policies.entries()) {
    if (seen.has(policy.edge)) fail(index, `guards ${policy.edge} twice; one edge takes one policy`)
    seen.add(policy.edge)
  }
  return policies
}
