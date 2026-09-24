/**
 * The judgement fence: run the configured stage assessments for one attempted
 * move and turn their answers into a transition decision.
 *
 * The rule the whole module exists to hold: **a judgement can only lose its
 * voice, never gain a veto it was not granted.** A warn edge records what the
 * model thought and always lets the move proceed; an enforce edge vetoes only
 * on the conditions its configuration spells out; and an unavailable
 * judgement vetoes only where the deployment explicitly chose `failClosed`.
 * The worst silent failure is therefore a move that passed with a note, never
 * one that was blocked by an accident.
 * @module @zhchxiao123/dsh-devflow-jev-gate/gate
 */

import type { GateCheck, TransitionAttempt, TransitionDecision } from '@zhchxiao123/dsh-devflow'
import type { EvaluationRecord } from '@zhchxiao123/dsh-devflow-jev'
import type { AssessmentKind } from '@zhchxiao123/dsh-devflow-jev'
import type { Answer } from '@zhchxiao123/dsh-jev'
import type { EdgePolicy } from './types.ts'

/** How the gate asks for one card assessment; index.ts binds it to `ctx.devflowJev`. */
export type Assess = (root: string, id: string, kind: AssessmentKind, signal: AbortSignal) => Promise<EvaluationRecord>

/** One assessment's outcome: a record, or the reason there is none. */
export interface Judgement {
  readonly kind: AssessmentKind
  readonly record?: EvaluationRecord
  readonly failure?: string
}

/** The actor every check this gate records is signed with. */
const BY = { kind: 'command', name: 'devflow-jev-gate' } as const

/**
 * Run every configured assessment for one attempt, each under its own
 * deadline. A judgement that misses the deadline, or whose call throws,
 * resolves to a failure entry — the fence downstream decides what a missing
 * judgement means, not this function.
 *
 * @param assess - the bound judgement call.
 * @param attempt - the move being decided.
 * @param policy - the matched edge policy.
 * @returns one {@link Judgement} per configured kind, in configuration order.
 */
export async function judge(assess: Assess, attempt: TransitionAttempt, policy: EdgePolicy): Promise<Judgement[]> {
  return Promise.all(policy.kinds.map(async (kind): Promise<Judgement> => {
    const control = new AbortController()
    const timer = setTimeout(() => { control.abort() }, policy.timeoutMs)
    try {
      return { kind, record: await assess(attempt.root, attempt.id, kind, control.signal) }
    } catch (error) {
      return {
        kind,
        failure: control.signal.aborted
          ? `timed out after ${String(policy.timeoutMs)}ms`
          : error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }))
}

function answerText(id: string, answer: Answer): string {
  switch (answer.type) {
    case 'choice': return `${id}=${answer.choice}@${(answer.probabilities[answer.choice] ?? 0).toFixed(2)}`
    case 'score': return `${id}=${answer.score.toFixed(2)}(c${answer.confidence.toFixed(2)})`
    case 'noul': return `${id}=${answer.noul.toFixed(2)}`
    default: return assertNever(answer)
  }
}

function assertNever(value: never): never { throw new Error(`Unsupported answer: ${String(value)}`) }

/**
 * Render one judgement as the journal's one-line account. A record line names
 * the evaluation id so the full answers, evidence digest, and any later human
 * accept/reject remain reachable from the journal entry.
 *
 * @param judgement - the assessment outcome.
 * @returns the {@link GateCheck} summary line.
 */
export function summarize(judgement: Judgement): string {
  const { kind, record, failure } = judgement
  if (record === undefined) return `jev ${kind}: unavailable (${failure ?? 'no judgement'})`
  if (record.status === 'unavailable') return `jev ${kind}: unavailable (${record.error?.code ?? 'unknown'})`
  const answers = Object.entries(record.answers).map(([id, answer]) => answerText(id, answer))
  return `jev ${kind} [${record.id}]: ${answers.length === 0 ? 'no answers' : answers.join(' ')}`
}

function available(judgement: Judgement): judgement is Judgement & { record: EvaluationRecord } {
  return judgement.record !== undefined && judgement.record.status !== 'unavailable'
}

/**
 * The first configured veto an enforce edge's judgements trigger.
 *
 * Condition evaluation is deliberately literal: `releaseBlockedMass` reads the
 * `releaseDecision` distribution, `riskScore` reads the `changeRisk` score and
 * vetoes only at or above its confidence floor — an uncertain high score is a
 * warning, not a block. A missing or unavailable answer falls under
 * `failClosed`, because "could not judge" and "judged fine" must not collapse
 * into the same outcome on an edge that chose to fail closed.
 *
 * @param policy - the matched enforce policy.
 * @param judgements - the edge's assessment outcomes.
 * @returns the veto reason, or `undefined` when the move may proceed.
 */
export function firstVeto(policy: EdgePolicy, judgements: readonly Judgement[]): string | undefined {
  const veto = policy.veto ?? {}
  for (const judgement of judgements) {
    if (!available(judgement)) {
      if (policy.failClosed === true) return `jev ${judgement.kind} judgement is unavailable and this edge fails closed`
      continue
    }
    const { answers } = judgement.record
    if (veto.releaseBlockedMass !== undefined && judgement.kind === 'release-readiness') {
      const answer = answers.releaseDecision
      if (answer?.type === 'choice') {
        const mass = (answer.probabilities.blocked ?? 0) + (answer.probabilities.unavailable ?? 0)
        if (mass >= veto.releaseBlockedMass) {
          return `jev release judgement wavers: P(blocked)+P(unavailable)=${mass.toFixed(2)} ≥ ${veto.releaseBlockedMass.toFixed(2)} (evaluation ${judgement.record.id})`
        }
      } else if (policy.failClosed === true) {
        return 'jev release-readiness left releaseDecision unanswered and this edge fails closed'
      }
    }
    if (veto.riskScore !== undefined && judgement.kind === 'implementation-risk') {
      const answer = answers.changeRisk
      if (answer?.type === 'score') {
        if (answer.score >= veto.riskScore && answer.confidence >= (veto.riskConfidence ?? 0)) {
          return `jev implementation risk ${answer.score.toFixed(2)} at confidence ${answer.confidence.toFixed(2)} ≥ ${veto.riskScore.toFixed(2)} (evaluation ${judgement.record.id})`
        }
      } else if (policy.failClosed === true) {
        return 'jev implementation-risk left changeRisk unanswered and this edge fails closed'
      }
    }
  }
  return undefined
}

/**
 * Build the `devflow/transition` waterfall listener.
 *
 * Downstream policies decide first: a move another gate vetoes is not judged
 * at all, so this gate spends judgements only on moves that would otherwise
 * land, and its checks join the decision that lands.
 *
 * @param policies - the validated edge policies.
 * @param assess - the bound judgement call.
 * @returns the waterfall listener.
 */
export function fence(policies: readonly EdgePolicy[], assess: Assess) {
  const byEdge = new Map(policies.map(policy => [policy.edge, policy]))
  return async (attempt: TransitionAttempt, next: () => Promise<TransitionDecision>): Promise<TransitionDecision> => {
    const policy = byEdge.get(`${attempt.from}->${attempt.to}`)
    if (policy === undefined) return await next()
    const decision = await next()
    if (!decision.allowed) return decision
    const judgements = await judge(assess, attempt, policy)
    if (policy.mode === 'enforce') {
      const reason = firstVeto(policy, judgements)
      if (reason !== undefined) return { allowed: false, reason }
    }
    const checks: GateCheck[] = judgements.map(judgement => ({ by: BY, verdict: 'allowed', summary: summarize(judgement) }))
    return { ...decision, checks: [...decision.checks ?? [], ...checks] }
  }
}
