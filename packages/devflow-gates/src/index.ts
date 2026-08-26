/**
 * Command gate policies on the `devflow/transition` waterfall: configured
 * edges run their gate commands through `ctx.shell` before the journal
 * commits, and a failing command vetoes the move with a bounded output
 * summary. Gate commands live entirely in deployment configuration (global
 * per-edge lists plus per-card overrides keyed by card id), never in the
 * card's writable files, so a developing agent cannot rewrite its own gates.
 * @module @zhchxiao123/dsh-devflow-gates
 */

import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isCardLocation } from '@zhchxiao123/dsh-devflow'
import type { DevActor, TransitionAttempt, TransitionDecision } from '@zhchxiao123/dsh-devflow'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
// Type-only: resolve the optional `ctx.agents` and `ctx.approval` lookups.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'

export const name = 'devflow-gates'
export const inject = ['shell']

/** Gate configuration; edge keys use the `from->to` form, e.g. `developing->reviewing`. */
export interface Config {
  /** Global gate commands per edge; every command must exit 0 for the move to proceed. */
  edges?: Record<string, string[]>
  /** Per-card overrides: card id → edge → commands, replacing the global list for that edge. */
  cards?: Record<string, Record<string, string[]>>
  /** Edges requiring a one-shot human approval (after the edge's commands pass). */
  approvals?: string[]
  /** Character cap for the failure-output summary carried in a veto reason. */
  maxFailureOutputChars?: number
}

/** Schemastery validator supplying the gate defaults. */
export const Config: z<Config> = z.object({
  edges: z.dict(z.array(z.string())).default({}),
  cards: z.dict(z.dict(z.array(z.string()))).default({}),
  approvals: z.array(z.string()).default([]),
  maxFailureOutputChars: z.number().default(2000),
})

function assertEdgeKey(key: string, owner: string): void {
  const parts = key.split('->')
  if (parts.length !== 2 || !isCardLocation(parts[0]) || !isCardLocation(parts[1])) {
    throw new Error(`devflow-gates: ${owner} names invalid edge "${key}"; use "<from>-><to>" with stage names or "blocked"`)
  }
}

/**
 * Register the command-gate listener on the transition waterfall.
 * @param ctx - registrant context carrying the shell executor.
 * @param config - deployment gate definitions; an invalid edge key fails the load.
 */
export function apply(ctx: Context, config: Config): void {
  const edges = config.edges ?? {}
  const cards = config.cards ?? {}
  const maxOutput = config.maxFailureOutputChars ?? 2000
  if (!Number.isInteger(maxOutput) || maxOutput < 1) {
    throw new Error('devflow-gates: maxFailureOutputChars must be a positive integer')
  }
  const approvals = new Set(config.approvals ?? [])
  for (const key of Object.keys(edges)) assertEdgeKey(key, 'edges')
  for (const [cardId, overrides] of Object.entries(cards)) {
    for (const key of Object.keys(overrides)) assertEdgeKey(key, `cards["${cardId}"]`)
  }
  for (const key of approvals) assertEdgeKey(key, 'approvals')

  ctx.on('devflow/transition', async (attempt: TransitionAttempt, next: () => Promise<TransitionDecision>): Promise<TransitionDecision> => {
    const edge = `${attempt.from}->${attempt.to}`
    const commands = cards[attempt.id]?.[edge] ?? edges[edge] ?? []
    for (const command of commands) {
      // Gate commands check the card's code, so they run in its workspace
      // directory — the parent of the card's devflow root.
      const result = await ctx.shell.run(ctx.shell.resolve({ command, workdir: dirname(attempt.root) }))
      if (result.exitCode !== 0) {
        return {
          allowed: false,
          reason: `gate command failed: ${command} (${describeExit(result)}): ${failureSummary(result, maxOutput)}`,
        }
      }
    }
    if (!approvals.has(edge)) return await next()
    return await approve(ctx, attempt, edge, next)
  })
}

/**
 * One-shot human approval over the interaction plane, answered outside the
 * model conversation. Without a reachable responder — no live initiating
 * agent, no composed approval service, or a fail-closed `unavailable` — the
 * move is vetoed and the card is parked `blocked` so an unattended run exits
 * cleanly and a human resumes it later.
 */
async function approve(
  ctx: Context,
  attempt: TransitionAttempt,
  edge: string,
  next: () => Promise<TransitionDecision>,
): Promise<TransitionDecision> {
  const reason = `devflow card ${attempt.id}: the ${edge} move requires human approval`
  const approval = ctx.get('approval')
  const agent = attempt.by.kind === 'agent' && attempt.by.session !== undefined
    ? ctx.get('agents')?.get(SessionId(attempt.by.session))
    : undefined
  if (approval === undefined || agent === undefined) {
    parkBlocked(ctx, attempt, edge)
    return { allowed: false, reason: `${reason}, and no approval responder is reachable; the card is parked blocked until a human resumes it` }
  }
  const outcome = await approval.request({ agent, toolName: 'devflow_transition', reason })
  if (outcome === 'allowed-once') {
    const decision = await next()
    if (!decision.allowed) return decision
    return { ...decision, approvedBy: { kind: 'human' } satisfies DevActor }
  }
  if (outcome === 'unavailable') {
    parkBlocked(ctx, attempt, edge)
    return { allowed: false, reason: `${reason}, and no answerer is composed; the card is parked blocked until a human resumes it` }
  }
  return { allowed: false, reason: `${reason} and the human ${outcome === 'cancelled' ? 'withdrew the question' : 'rejected it'}` }
}

/** Queue the blocked parking move behind the vetoed transition's serialization; failure only warns. */
function parkBlocked(ctx: Context, attempt: TransitionAttempt, edge: string): void {
  const devflow = ctx.get('devflow')
  /* v8 ignore next -- the waterfall only dispatches from a live devflow store. */
  if (devflow === undefined) return
  void devflow.transition(devflow.resolve({
    id: attempt.id,
    to: 'blocked',
    expectedRevision: attempt.expectedRevision,
    by: { kind: 'command', name: 'devflow-gates' },
    reason: `awaiting human approval for ${edge}`,
    root: attempt.root,
  })).then((parked) => {
    if (!parked.ok) {
      ctx.logger.warn(`devflow-gates: failed to park card ${attempt.id} blocked: ${parked.message}`)
    }
  }, (error: unknown) => {
    ctx.logger.warn(`devflow-gates: failed to park card ${attempt.id} blocked: ${String(error)}`)
  })
}

function describeExit(result: ShellRunResult): string {
  return result.exitCode === null ? 'killed' : `exit ${result.exitCode}`
}

function failureSummary(result: ShellRunResult, maxChars: number): string {
  const text = [result.stderr.text.trim(), result.stdout.text.trim()].filter(part => part.length > 0).join('\n')
  if (text.length === 0) return 'no output'
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}… (truncated)`
}
