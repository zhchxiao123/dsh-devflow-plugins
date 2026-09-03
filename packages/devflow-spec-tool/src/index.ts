/**
 * Model-facing spec tool: `devflow_write_spec` commits one architecture
 * document, whose claims must be tied to the code by evaluable anchors. It is
 * a thin Consumer over `ctx.devflowSpec`; id legality, the structural contract,
 * and anchor evaluation live behind the seam, so a rejection here carries the
 * seam's own stable code and message.
 *
 * This is the only way a document reaches disk. That is enforced rather than
 * intended: the spec root sits under `.devflow/`, which
 * `@zhchxiao123/dsh-devflow-fs-guard` denies the file tools.
 * @module @zhchxiao123/dsh-devflow-spec-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ANCHOR_KINDS, SOURCE_OF_TRUTH_HEADING } from '@zhchxiao123/dsh-devflow-spec'
import type { SpecAnchorRequest } from '@zhchxiao123/dsh-devflow-spec'

export const name = 'tool-devflow-spec'
export const inject = ['tools', 'devflowSpec']

/** One anchor as the model states it. */
const ANCHOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Document-local id the body cites as [[id]].' },
    kind: { type: 'string', required: true, enum: [...ANCHOR_KINDS], description: 'symbol: the name must still exist. content-hash: its implementation must be unchanged. churn: the file must not have been committed after this document.' },
    file: { type: 'string', required: true, description: 'Repository-relative path of the anchored file.' },
    symbol: { type: 'string', description: 'Required for symbol and content-hash anchors.' },
    hash: { type: 'string', description: 'Optional. Omit it: the store records the anchored symbol\'s current digest, which is what you mean by anchoring an implementation as it stands today.' },
  },
} as const

/** One anchor's verdict as the read result reports it. */
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['fresh', 'stale', 'unevaluable'] },
    reason: { type: 'string' },
  },
} as const

/**
 * The warning a reader must see before a document it cannot rely on. A read
 * that returned only the body would drop the one signal this seam exists to
 * carry, and the reader would have no way to know it was dropped.
 * The failing anchors are named but their reasons are not repeated here — the
 * structured result carries them, and duplicating prose into the rendered text
 * only lengthens it.
 * @param freshness - the document's rolled-up freshness.
 * @param verdicts - its anchor verdicts.
 * @returns the warning lines, empty while every anchor is fresh.
 */
function freshnessWarning(freshness: string, verdicts: readonly { id: string; status: string }[]): string {
  if (freshness === 'fresh') return ''
  const failing = verdicts.filter(verdict => verdict.status !== 'fresh').map(verdict => `${verdict.id} (${verdict.status})`).join(', ')
  return `!! This document is ${freshness}; check it against the code before following it. Anchors: ${failing}.\n\n`
}

/**
 * The acting agent; a non-agent caller has no owning session to attribute a
 * write to and is rejected before any side effect.
 * @param exec - the tool execution context.
 * @returns the executing agent.
 */
function requireAgent(exec: ToolRunContext): NonNullable<ToolRunContext['agent']> {
  if (!exec.agent) {
    throw new Error('writing a spec document requires an owning agent session')
  }
  return exec.agent
}

/**
 * Register the spec tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and the spec store.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'devflow_write_spec',
    description:
      'Write one architecture document for this workspace. '
      + 'Every substantive claim must rest on a declared anchor cited in the body as [[id]], '
      + `and the body must carry a "## ${SOURCE_OF_TRUTH_HEADING}" section listing what each anchor points at. `
      + 'Anchors are what make the document self-invalidating: when the anchored code changes, '
      + 'readers are told the document is stale instead of following it. '
      + 'Every anchor must resolve at write time — a document may not be born stale. '
      + 'This creates a document; it does not revise an existing one.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Slash-joined scope path, e.g. "@scope/package/backend/error-handling". Each segment must match ^[@a-z0-9][a-z0-9._@-]*$.',
      },
      title: { type: 'string', required: true, description: 'Human title of the document.' },
      description: { type: 'string', description: 'One-line summary; the only description the index shows.' },
      body: {
        type: 'string',
        required: true,
        description: `Markdown below the frontmatter. Must contain a "## ${SOURCE_OF_TRUTH_HEADING}" section, and must cite every declared anchor as [[id]].`,
      },
      anchors: {
        type: 'array',
        required: true,
        items: ANCHOR_SCHEMA,
        description: 'What the document\'s claims rest on. At least one; a document that anchors nothing would report fresh forever.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          path: { type: 'string', required: true },
          anchors: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Wrote spec ${value.id} (${value.anchors} anchor${value.anchors === 1 ? '' : 's'}) at ${value.path}.`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const store = ctx.devflowSpec
      const result = await store.write(store.resolveWrite({
        id: args.id,
        title: args.title,
        ...(args.description === undefined ? {} : { description: args.description }),
        body: args.body,
        anchors: args.anchors as SpecAnchorRequest[],
      }))
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
      return { id: result.document.id, path: result.document.path, anchors: args.anchors.length }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Write spec ${args.id}`,
      rawInput: args.title,
      kind: 'edit',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'devflow_read_spec',
    description:
      'Read one architecture document of this workspace, with its anchors evaluated against the code as it stands now. '
      + 'The result says whether the document is still trustworthy: an anchor that no longer resolves makes it stale, '
      + 'and a stale document must be checked against the code before it is followed. '
      + 'Use devflow_write_spec to record a corrected one.',
    parameters: {
      id: { type: 'string', required: true, description: 'The document id, as the index reports it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          description: { type: 'string' },
          path: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
          freshness: { type: 'string', required: true, enum: ['fresh', 'stale', 'unevaluable'] },
          body: { type: 'string', required: true },
          verdicts: { type: 'array', required: true, items: VERDICT_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${freshnessWarning(value.freshness, value.verdicts)}# ${value.title}\n\n${value.body}`,
      }],
    },
    async execute(args) {
      const document = await ctx.devflowSpec.read(args.id)
      return {
        id: document.id,
        title: document.title,
        ...(document.description === undefined ? {} : { description: document.description }),
        path: document.path,
        updatedAt: document.updatedAt,
        freshness: document.freshness,
        body: document.body,
        verdicts: document.verdicts,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Read spec ${args.id}`,
      rawInput: args.id,
      kind: 'read',
    }),
  }))
}
