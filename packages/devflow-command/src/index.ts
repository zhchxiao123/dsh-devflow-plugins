/**
 * Human-facing `/devflow` intervention command over the task-card seam: the
 * deterministic plane for board views, stage moves, blocked recovery, lease
 * takeover, and archiving — no model turn, journal actor `command devflow`.
 * Moves go through the ordinary transition executor, so gates still decide;
 * only the lease takeover forces (any heartbeat counts as stale).
 * @module @zhchxiao123/dsh-devflow-command
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { DevflowCardId, isCardLocation } from '@zhchxiao123/dsh-devflow'
import type { DevActor, DevCard } from '@zhchxiao123/dsh-devflow'

export const name = 'command-devflow'
export const inject = ['commands', 'devflow']

const USAGE = 'Usage: /devflow [show <id>|move <id> <stage> [reason]|takeover <id>|archive]'

/** The command plane's journal identity. */
const COMMAND_ACTOR: DevActor = { kind: 'command', name: 'devflow' }

type DevflowCommand =
  | { readonly kind: 'board' }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'move'; readonly id: string; readonly to: string; readonly reason?: string }
  | { readonly kind: 'takeover'; readonly id: string }
  | { readonly kind: 'archive' }
  | { readonly kind: 'invalid'; readonly problem: string }

/** Parse only the grammar owned by `/devflow`. */
function parseDevflowCommand(rawInput: string): DevflowCommand {
  const parts = rawInput.trim().split(/\s+/u).filter(part => part.length > 0)
  if (parts.length === 0) return { kind: 'board' }
  const [verb = '', ...rest] = parts
  const [first = '', second = ''] = rest
  switch (verb.toLowerCase()) {
    case 'show':
      return rest.length === 1 ? { kind: 'show', id: first } : { kind: 'invalid', problem: 'show takes exactly one card id' }
    case 'move': {
      if (rest.length < 2) return { kind: 'invalid', problem: 'move takes a card id and a target stage' }
      const reasonWords = rest.slice(2)
      return {
        kind: 'move',
        id: first,
        to: second,
        ...reasonWords.length > 0 ? { reason: reasonWords.join(' ') } : {},
      }
    }
    case 'takeover':
      return rest.length === 1 ? { kind: 'takeover', id: first } : { kind: 'invalid', problem: 'takeover takes exactly one card id' }
    case 'archive':
      return rest.length === 0 ? { kind: 'archive' } : { kind: 'invalid', problem: 'archive takes no arguments' }
    default:
      return { kind: 'invalid', problem: `unknown subcommand "${verb}"` }
  }
}

/** One board line: id, location, revision, title. */
function cardLine(card: DevCard): string {
  const blocked = card.blockedFrom === undefined ? '' : ` (from ${card.blockedFrom})`
  return `${card.id} [${card.stage}${blocked}] rev ${card.stageRevision} — ${card.title}`
}

/**
 * Render the board one level deep: each child sits indented under the parent
 * it decomposes. A child whose parent left the active set keeps its backlink
 * on its own line instead of disappearing into the flat list.
 * @param cards - the root's active cards, ordered by id.
 * @returns the board lines, in reading order.
 */
function boardLines(cards: readonly DevCard[]): string[] {
  const children = new Map<string, DevCard[]>()
  for (const card of cards) {
    if (card.parent === undefined) continue
    children.set(card.parent, [...children.get(card.parent) ?? [], card])
  }
  const present = new Set<string>(cards.map(card => card.id))
  const lines: string[] = []
  for (const card of cards) {
    if (card.parent !== undefined && present.has(card.parent)) continue
    lines.push(card.parent === undefined ? cardLine(card) : `${cardLine(card)} (part of ${card.parent})`)
    for (const child of children.get(card.id) ?? []) lines.push(`  ${cardLine(child)}`)
  }
  return lines
}

/**
 * The invoking session's devflow root: `<session cwd>/.devflow` when the
 * session carries a working directory; without one the store's configured
 * default root applies.
 */
function invocationRoot(invocation: CommandInvocation): string | undefined {
  const cwd = invocation.agent.session.header.cwd
  return cwd === undefined ? undefined : join(cwd, '.devflow')
}

/**
 * The card's breakdown block: one indented line per child, empty for a card
 * with no children.
 * @param ctx - context carrying the devflow store.
 * @param card - the top-level card being shown.
 * @param root - the invoking session's devflow root.
 * @returns the block to append to the card line, starting with a newline.
 */
async function breakdownLine(ctx: Context, card: DevCard, root: string | undefined): Promise<string> {
  const children = await ctx.devflow.list({ parent: card.id }, root)
  if (children.length === 0) return ''
  return `\nsub-requirements:\n${children.map(child => `  ${cardLine(child)}`).join('\n')}`
}

/**
 * The backlink line of a child card, naming the requirement it decomposes.
 * @param ctx - context carrying the devflow store.
 * @param parent - the parent card id.
 * @param root - the invoking session's devflow root.
 * @returns the backlink, with the parent's title when it is still readable.
 */
async function backlinkLine(ctx: Context, parent: DevflowCardId, root: string | undefined): Promise<string> {
  try {
    return `part of ${parent} — ${(await ctx.devflow.read(parent, root)).title}`
  } catch {
    // Swallows every read failure of the parent — a card archived ahead of its
    // children, an unreadable journal, a vanished directory. The child's own
    // card is what the caller asked for, and it already read: a broken backlink
    // degrades to the bare id rather than failing the whole view.
    return `part of ${parent}`
  }
}

/** Execute one parsed intervention through the seam that owns enforcement. */
async function executeDevflowCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const command = parseDevflowCommand(invocation.rawInput)
  const root = invocationRoot(invocation)
  switch (command.kind) {
    case 'invalid':
      return { kind: 'error', text: `${command.problem}. ${USAGE}` }
    case 'board': {
      const cards = await ctx.devflow.list(undefined, root)
      if (cards.length === 0) return { kind: 'success', text: `No devflow cards.\n${USAGE}` }
      return { kind: 'success', text: boardLines(cards).join('\n') }
    }
    case 'show': {
      const card = await ctx.devflow.read(DevflowCardId(command.id), root)
      const artifacts = card.artifacts.length === 0 ? '' : `\nartifacts: ${card.artifacts.join(', ')}`
      const relation = card.parent === undefined
        ? await breakdownLine(ctx, card, root)
        : `\n${await backlinkLine(ctx, card.parent, root)}`
      return { kind: 'success', text: `${cardLine(card)}${relation}${artifacts}\n\n${card.body}` }
    }
    case 'move': {
      if (!isCardLocation(command.to)) {
        return { kind: 'error', text: `"${command.to}" is not a stage or "blocked". ${USAGE}` }
      }
      const card = await ctx.devflow.read(DevflowCardId(command.id), root)
      const result = await ctx.devflow.transition(ctx.devflow.resolve({
        id: card.id,
        to: command.to,
        expectedRevision: card.stageRevision,
        by: COMMAND_ACTOR,
        ...command.reason !== undefined ? { reason: command.reason } : {},
        ...root !== undefined ? { root } : {},
      }))
      if (!result.ok) return { kind: 'error', text: result.message }
      return { kind: 'success', text: `Card ${card.id} moved ${result.from} -> ${result.card.stage} (rev ${result.card.stageRevision}).` }
    }
    case 'takeover': {
      // Force: any heartbeat counts as stale, so the eviction is always
      // journaled and the stale holder's next revision-checked commit fails.
      const taken = await ctx.devflow.claim(DevflowCardId(command.id), COMMAND_ACTOR, {
        staleAfterMs: 0,
        ...root !== undefined ? { root } : {},
      })
      if (!taken.ok) return { kind: 'error', text: taken.message }
      await taken.handle.release()
      return { kind: 'success', text: `Lease on card ${command.id} taken over and released; the previous holder's next commit will be rejected by the revision check.` }
    }
    case 'archive': {
      const archived = await ctx.devflow.archiveDone(root)
      return archived.length === 0
        ? { kind: 'success', text: 'No done cards to archive.' }
        : { kind: 'success', text: `Archived ${archived.length} card(s): ${archived.join(', ')}.` }
    }
  }
}

/**
 * Register the `/devflow` command for every composed command adapter.
 * @param ctx - registrant context carrying the command registry and the devflow store.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'devflow',
    description: 'inspect or intervene on the devflow task board',
    input: { hint: '[show <id>|move <id> <stage> [reason]|takeover <id>|archive]' },
    handler: async invocation => await executeDevflowCommand(ctx, invocation),
  })
}
