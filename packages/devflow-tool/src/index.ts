/**
 * Model-facing devflow tools: `devflow_list` surveys the task board,
 * `devflow_show` reads one card, `devflow_create` turns a chat-agreed
 * requirement into a new draft card, `devflow_take` claims a ready card into
 * development, and `devflow_transition` commits one stage move. All are thin
 * Consumers over `ctx.devflow`; state derivation, edge legality, and rejection
 * semantics live behind the seam, and every committed agent-initiated creation
 * and move is also recorded in the calling agent's Session. Named exports
 * preserve loader injection metadata.
 * @module @zhchxiao123/dsh-devflow-tool
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { DEV_STAGES, DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { CardFilter, CardLocation, DevActor, DevCard, TransitionResult } from '@zhchxiao123/dsh-devflow'
export const name = 'tool-devflow'
export const inject = ['tools', 'devflow']

/** Card locations offered in the model-facing stage filter. */
const LOCATIONS = [...DEV_STAGES, 'blocked'] as const

/** Summary fields shared by the list rows and the show result. */
const CARD_SUMMARY_PROPERTIES = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  stage: { type: 'string', required: true, enum: [...LOCATIONS] },
  stageRevision: { type: 'integer', required: true },
  parent: { type: 'string' },
} as const

const CARD_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: CARD_SUMMARY_PROPERTIES,
} as const

interface CardSummary {
  id: string
  title: string
  stage: CardLocation
  stageRevision: number
  parent?: string
}

function summarize(card: DevCard): CardSummary {
  return {
    id: card.id,
    title: card.title,
    stage: card.stage,
    stageRevision: card.stageRevision,
    ...card.parent !== undefined ? { parent: card.parent } : {},
  }
}

/** One board line; a child names the requirement it decomposes. */
function summaryLine(card: CardSummary): string {
  const parent = card.parent === undefined ? '' : ` (part of ${card.parent})`
  return `${card.id} [${card.stage}] ${card.title}${parent}`
}

/**
 * The title behind a card's parent backlink.
 * @param ctx - context carrying the devflow store.
 * @param id - the parent card id.
 * @param root - the caller's devflow root.
 * @returns the parent's title, or `undefined` when it left the active set
 *   (archived ahead of its children); the backlink id still reaches the model.
 */
async function titleOf(ctx: Context, id: DevflowCardId, root: string | undefined): Promise<string | undefined> {
  try {
    return (await ctx.devflow.read(id, root)).title
  } catch {
    // Swallows every read failure of the parent — a card archived ahead of its
    // children, an unreadable journal, a vanished directory. The child's own
    // card is what the caller asked for, and it already read: a broken backlink
    // degrades to the bare id rather than failing the whole view.
    return undefined
  }
}

/**
 * The acting agent; a non-agent caller has no owning session to attribute a
 * move to and is rejected.
 * @param exec - the tool execution context.
 * @returns the executing agent.
 */
function requireAgent(exec: ToolRunContext): NonNullable<ToolRunContext['agent']> {
  if (!exec.agent) {
    throw new Error('devflow mutations require an owning agent session')
  }
  return exec.agent
}

/**
 * The caller's devflow root: `<session cwd>/.devflow` for an agent whose
 * session carries a working directory. A caller without one derives no root,
 * so the store's configured default applies.
 * @param exec - the tool execution context.
 * @returns the derived root, or `undefined` when none derives.
 */
function callerRoot(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  return cwd === undefined ? undefined : join(cwd, '.devflow')
}

/**
 * Shape a committed move into the canonical tool value. The move itself is
 * already durable in the card's journal, and the call and this value are
 * already in the session log as `tool/call` and `tool/result`.
 * @param result - a successful transition result.
 * @returns the canonical tool value.
 */
function committedMove(
  result: Extract<TransitionResult, { ok: true }>,
): { id: string; from: CardLocation; to: CardLocation; stageRevision: number } {
  return { id: result.card.id, from: result.from, to: result.card.stage, stageRevision: result.card.stageRevision }
}

/**
 * Register the devflow read tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and the devflow store.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'devflow_list',
    description:
      'List the devflow task cards of this workspace with their current stage. '
      + 'Each card is one unit of development work moving through '
      + 'draft, designing, ready, developing, reviewing, testing, done; '
      + '`blocked` marks a card waiting on something external. '
      + 'A big requirement is split into child cards that name it as their `parent`. '
      + 'Use `stage` to list only the cards at one location, or `parent` to list one requirement\'s breakdown.',
    parameters: {
      stage: {
        type: 'string',
        enum: [...LOCATIONS],
        description: 'Only list cards currently at this stage (or `blocked`).',
      },
      parent: {
        type: 'string',
        description: 'Only list the child cards decomposing this card id.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cards: { type: 'array', required: true, items: CARD_SUMMARY_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.cards.length === 0
          ? 'No devflow cards.'
          : value.cards.map(summaryLine).join('\n'),
      }],
    },
    async execute(args, exec) {
      const filter: CardFilter = {
        ...args.stage !== undefined ? { stage: args.stage } : {},
        ...args.parent !== undefined ? { parent: DevflowCardId(args.parent) } : {},
      }
      const cards = await ctx.devflow.list(filter, callerRoot(exec))
      return { cards: cards.map(summarize) }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.parent !== undefined
        ? `List devflow cards under ${args.parent}`
        : args.stage === undefined ? 'List devflow cards' : `List devflow cards at ${args.stage}`,
      kind: 'read',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'devflow_create',
    description:
      'Create a new devflow task card from the current discussion. Give it a concise title '
      + 'and a Markdown body carrying the requirement and its acceptance criteria; the card '
      + 'starts at draft with a fresh sequence number. Use this when the user asks to turn '
      + 'an agreed plan or requirement into a tracked task. A requirement too big for one card '
      + 'becomes a parent card plus one child card per slice, each created with `parent` set to '
      + 'the parent\'s id; keep every child body self-contained.',
    parameters: {
      title: { type: 'string', required: true, description: 'Human title of the card.' },
      body: {
        type: 'string',
        required: true,
        description: 'Markdown body: the requirement and its acceptance criteria.',
      },
      slug: {
        type: 'string',
        description: 'Directory-name slug (lowercase letters, digits, dashes); omitted derives one from the title.',
      },
      parent: {
        type: 'string',
        description:
          'Id of the bigger card this one decomposes; omitted creates a top-level card. '
          + 'The parent must itself be top-level and not done — the breakdown is one level deep.',
      },
    },
    output: {
      schema: CARD_SUMMARY_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Created card ${value.id} [${value.stage}] ${value.title}.`,
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const root = callerRoot(exec)
      const result = await ctx.devflow.create(ctx.devflow.resolveCreate({
        title: args.title,
        body: args.body,
        ...args.slug !== undefined ? { slug: args.slug } : {},
        ...args.parent !== undefined ? { parent: DevflowCardId(args.parent) } : {},
        by: { kind: 'agent', session: agent.session.id },
        ...root !== undefined ? { root } : {},
      }))
      if (!result.ok) throw new Error(result.message)
      return summarize(result.card)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Create devflow card: ${args.title}`,
      kind: 'edit',
      rawInput: {
        title: args.title,
        ...args.slug !== undefined ? { slug: args.slug } : {},
        ...args.parent !== undefined ? { parent: args.parent } : {},
      },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'devflow_show',
    description:
      'Read one devflow task card: its title, current stage, stage revision, '
      + 'registered artifacts, and full Markdown body (requirements and acceptance criteria). '
      + 'A child card names the requirement it decomposes — read that card for the whole picture; '
      + 'a parent card lists its breakdown.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The card id, as listed by devflow_list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...CARD_SUMMARY_PROPERTIES,
          blockedFrom: { type: 'string', enum: [...DEV_STAGES] },
          parentTitle: { type: 'string' },
          children: { type: 'array', required: true, items: CARD_SUMMARY_SCHEMA },
          path: { type: 'string', required: true },
          artifacts: { type: 'array', required: true, items: { type: 'string' } },
          body: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.id} [${value.stage}] ${value.title} (rev ${value.stageRevision})`,
          ...value.parent === undefined
            ? []
            : [value.parentTitle === undefined ? `part of ${value.parent}` : `part of ${value.parent} — ${value.parentTitle}`],
          ...value.children.length === 0
            ? []
            : ['sub-requirements:', ...value.children.map(child => `  ${summaryLine(child)}`)],
          '',
          value.body,
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const root = callerRoot(exec)
      const card = await ctx.devflow.read(DevflowCardId(args.id), root)
      // Only one level exists, so a child never has children of its own.
      const children = card.parent === undefined ? await ctx.devflow.list({ parent: card.id }, root) : []
      const parentTitle = card.parent === undefined ? undefined : await titleOf(ctx, card.parent, root)
      return {
        ...summarize(card),
        ...card.blockedFrom !== undefined ? { blockedFrom: card.blockedFrom } : {},
        ...parentTitle !== undefined ? { parentTitle } : {},
        children: children.map(summarize),
        path: card.path,
        artifacts: card.artifacts,
        body: card.body,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Show devflow card ${args.id}`,
      kind: 'read',
      rawInput: args.id,
    }),
  }))

  const TRANSITION_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      from: { type: 'string', required: true, enum: [...LOCATIONS] },
      to: { type: 'string', required: true, enum: [...LOCATIONS] },
      stageRevision: { type: 'integer', required: true },
    },
  } as const

  const renderMove = (value: { id: string; from: string; to: string; stageRevision: number }): { type: 'text'; text: string }[] => [{
    type: 'text',
    text: `Card ${value.id} moved ${value.from} -> ${value.to} (rev ${value.stageRevision}).`,
  }]

  ctx.tools.register(defineTool({
    name: 'devflow_transition',
    description:
      'Move one devflow task card to a new stage. Pass the `stageRevision` you last observed '
      + '(from devflow_list or devflow_show): the move is rejected if the card changed since. '
      + 'Rejections name the cause — a stale revision, an illegal edge, or a policy veto — '
      + 'and are not retried automatically. Provide `reason` when reworking a card backwards.',
    parameters: {
      id: { type: 'string', required: true, description: 'The card id, as listed by devflow_list.' },
      to: {
        type: 'string',
        required: true,
        enum: [...LOCATIONS],
        description: 'Target stage; must be a legal edge from the card\'s current stage.',
      },
      expectedRevision: {
        type: 'integer',
        required: true,
        description: 'The stageRevision you last observed for this card.',
      },
      reason: { type: 'string', description: 'Why the card moves; recorded in the card history.' },
    },
    output: { schema: TRANSITION_OUTPUT, render: (_args, value) => renderMove(value) },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const root = callerRoot(exec)
      const by: DevActor = { kind: 'agent', session: agent.session.id }
      const result = await ctx.devflow.transition(ctx.devflow.resolve({
        id: DevflowCardId(args.id),
        to: args.to,
        expectedRevision: args.expectedRevision,
        by,
        ...args.reason !== undefined ? { reason: args.reason } : {},
        ...root !== undefined ? { root } : {},
      }))
      if (!result.ok) throw new Error(result.message)
      return committedMove(result)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Move devflow card ${args.id} to ${args.to}`,
      kind: 'edit',
      rawInput: { id: args.id, to: args.to, expectedRevision: args.expectedRevision },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'devflow_take',
    description:
      'Claim a ready devflow task card and start developing it: takes the card\'s exclusive '
      + 'lease, then moves it ready -> developing. Fails without side effects if the card is '
      + 'already claimed, is not at ready, or changed since the `stageRevision` you observed.',
    parameters: {
      id: { type: 'string', required: true, description: 'The card id, as listed by devflow_list.' },
      expectedRevision: {
        type: 'integer',
        required: true,
        description: 'The stageRevision you last observed for this card.',
      },
    },
    output: { schema: TRANSITION_OUTPUT, render: (_args, value) => renderMove(value) },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const root = callerRoot(exec)
      const by: DevActor = { kind: 'agent', session: agent.session.id }
      const id = DevflowCardId(args.id)
      const claim = await ctx.devflow.claim(id, by, root === undefined ? undefined : { root })
      if (!claim.ok) throw new Error(claim.message)
      const result = await ctx.devflow.transition(ctx.devflow.resolve({
        id,
        to: 'developing',
        expectedRevision: args.expectedRevision,
        by,
        ...root !== undefined ? { root } : {},
      }))
      if (!result.ok) {
        // The failed take must leave no side effects; the lease is released
        // before the rejection reaches the model.
        await claim.handle.release()
        throw new Error(result.message)
      }
      return committedMove(result)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Take devflow card ${args.id}`,
      kind: 'edit',
      rawInput: { id: args.id, expectedRevision: args.expectedRevision },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'devflow_attach_artifact',
    description:
      'Register a stage deliverable on a devflow task card (e.g. artifacts/design.md) against '
      + 'its current stage. Write the file first; this records its path in the card history. '
      + 'Pass the `stageRevision` you last observed; rejected if the card changed since, '
      + 'or if the card is blocked or done.',
    parameters: {
      id: { type: 'string', required: true, description: 'The card id, as listed by devflow_list.' },
      path: {
        type: 'string',
        required: true,
        description: 'Artifact path relative to the card directory, e.g. artifacts/design.md.',
      },
      expectedRevision: {
        type: 'integer',
        required: true,
        description: 'The stageRevision you last observed for this card.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          path: { type: 'string', required: true },
          stage: { type: 'string', required: true, enum: [...LOCATIONS] },
          stageRevision: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Registered ${value.path} on card ${value.id} at ${value.stage} (rev ${value.stageRevision}).`,
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const root = callerRoot(exec)
      const result = await ctx.devflow.attachArtifact({
        id: DevflowCardId(args.id),
        path: args.path,
        expectedRevision: args.expectedRevision,
        by: { kind: 'agent', session: agent.session.id },
        ...root !== undefined ? { root } : {},
      })
      if (!result.ok) throw new Error(result.message)
      return {
        id: result.card.id,
        path: args.path,
        stage: result.card.stage,
        stageRevision: result.card.stageRevision,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Register artifact ${args.path} on ${args.id}`,
      kind: 'edit',
      rawInput: { id: args.id, path: args.path },
    }),
  }))
}
