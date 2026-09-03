/**
 * Capture a rule from the conversation.
 *
 * `devflow_record_iron_rule` is the only writer, and the `devflowIronRules`
 * service IS that tool's write path published for other plugins — not a second
 * one. Stating a rule is easy; expressing it accurately for THIS repository,
 * and writing a `check.sh` that uses its real paths and patterns without false
 * positives, needs the code in front of you, which is why recording is a model
 * action rather than a command that writes what a user typed.
 *
 * Recording writes `owner: local` unconditionally. An `admin` rule draws its
 * force from code review, and minting one from a chat turn would skip exactly
 * the review that gives it that force — promotion is a reviewed edit to the
 * file, not a parameter.
 * @module @zhchxiao123/dsh-devflow-iron-rules/record
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './index.ts'
import { buildAddition, digestRules } from './inject.ts'
import { loadRules, rulesByteSize, validateRuleId, workspaceOf } from './rules.ts'
import type { IronRule, RecordInput, RecordOutcome } from './types.ts'

/**
 * Reject an input whose triage does not hold together.
 *
 * `judgement` carrying a check is refused rather than quietly ignored: it
 * means the caller did not actually decide, and accepting it would make the
 * required field a formality.
 * @param input - the rule as supplied.
 * @returns a diagnostic naming what is missing, or `undefined` when coherent.
 */
export function triageDiagnostic(input: RecordInput): string | undefined {
  const hasCheck = input.check !== undefined && input.check.trim().length > 0
  const hasWatches = input.watches !== undefined && input.watches.length > 0
  if (input.enforcement === 'script') {
    if (!hasCheck) return 'enforcement "script" requires a `check` script; if no machine can verify this rule, declare "judgement" instead'
    if (!hasWatches) return 'enforcement "script" requires `watches` — the path prefixes the check looks at, which is how a later session detects the script has gone stale'
    return undefined
  }
  return hasCheck
    ? 'enforcement "judgement" contradicts the supplied `check` script; if a machine can verify this rule, declare "script"'
    : undefined
}

/**
 * Write one rule and make it effective immediately.
 *
 * The injected delta is what makes a just-recorded rule apply to the very next
 * request: waiting for a filesystem event would leave the rule inert for the
 * rest of the session, which is the whole reason this plugin owns its own
 * injection rather than appending to `AGENTS.md`.
 *
 * Every rejection happens before the first write, so a refused replacement
 * leaves the rule set exactly as it was.
 * @param ctx - the cordis context, for logging.
 * @param agent - the agent whose workspace and context receive the rule.
 * @param input - the rule to write, including any ids it replaces.
 * @param config - the resolved plugin configuration.
 * @returns whether the rule was written, with text for the calling surface.
 */
export async function recordRule(
  ctx: Context,
  agent: Agent,
  input: RecordInput,
  config: ResolvedConfig,
): Promise<RecordOutcome> {
  const diagnostic = validateRuleId(input.id)
  if (diagnostic !== undefined) return { ok: false, text: diagnostic }
  if (input.title.trim().length === 0) return { ok: false, text: 'a rule needs a non-empty title' }
  const triage = triageDiagnostic(input)
  if (triage !== undefined) return { ok: false, text: triage }

  const { rules, rulesDir } = await loadRules(workspaceOf(agent, config))

  // Everything below this line validates BEFORE the first write. A half-applied
  // replacement — new rule written, old one still there — would leave exactly
  // the duplication this feature exists to remove.
  const replaces = input.replaces ?? []
  const byId = new Map(rules.map(rule => [rule.id, rule]))
  const missing = replaces.filter(id => !byId.has(id))
  if (missing.length > 0) {
    return { ok: false, text: `replaces names rules that do not exist: ${missing.join(', ')}` }
  }
  const protectedIds = replaces.filter(id => byId.get(id)?.owner === 'admin')
  if (protectedIds.length > 0) {
    return {
      ok: false,
      text: `team rules cannot be replaced: ${protectedIds.join(', ')}. An admin rule draws its force from code review; changing it is a reviewed edit to the file.`,
    }
  }
  if (byId.has(input.id) && !replaces.includes(input.id)) {
    return {
      ok: false,
      text: `rule [${input.id}] already exists. To revise it, list it in \`replaces\`; otherwise pick another id.`,
    }
  }

  // Budget the NET change. A merge that folds three rules into one is a
  // reduction, and charging it as pure addition would refuse the very move
  // that relieves the pressure.
  const retained = rules.filter(rule => !replaces.includes(rule.id))
  const addition = Buffer.byteLength(input.title) + Buffer.byteLength(input.body)
  const projected = rulesByteSize(retained) + addition
  if (projected > config.maxBytes) {
    return {
      ok: false,
      text: `the rule set would total about ${String(projected)} bytes, over the ${String(config.maxBytes)} byte ceiling. Merge or retire existing rules first.`,
    }
  }

  const dir = join(rulesDir, input.id)
  const frontmatter = [
    '---',
    `id: ${input.id}`,
    `title: ${input.title}`,
    'owner: local',
    `enforcement: ${input.enforcement}`,
    ...input.watches !== undefined && input.watches.length > 0 ? [`watches: ${input.watches.join(' ')}`] : [],
    '---',
  ].join('\n')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'RULE.md'), `${frontmatter}\n\n${input.body}\n`, 'utf8')
    if (input.enforcement === 'script' && input.check !== undefined) {
      await writeFile(join(dir, 'check.sh'), input.check.endsWith('\n') ? input.check : `${input.check}\n`, 'utf8')
    }
    // Delete only after the replacement exists. git carries the history, so a
    // removal here is recoverable and reviewable as an ordinary diff.
    for (const id of replaces) {
      if (id !== input.id) await rm(join(rulesDir, id), { recursive: true, force: true })
    }
  } catch (error: unknown) {
    return { ok: false, text: `writing the rule failed: ${String(error)}` }
  }

  const rule: IronRule = {
    id: input.id,
    title: input.title,
    owner: 'local',
    body: input.body,
    dir,
    enforcement: input.enforcement,
    ...input.enforcement === 'script' ? { checkScript: join(dir, 'check.sh') } : {},
    ...input.watches !== undefined && input.watches.length > 0 ? { watches: input.watches } : {},
  }
  // Digest the set as it now stands on disk, so the next pre-step reads the
  // context as current and appends no duplicate baseline.
  const superseded = replaces.filter(id => id !== input.id)
  agent.inject(buildAddition(rule, digestRules([...retained, rule]), superseded))
  ctx.logger.info(`devflow-iron-rules: recorded [${input.id}] (${input.enforcement})${superseded.length > 0 ? ` replacing ${superseded.join(', ')}` : ''}`)

  const merged = superseded.length > 0 ? `, merging ${superseded.map(id => `[${id}]`).join(', ')}` : ''
  const enforced = input.enforcement === 'script' ? '; its check script runs when the next turn that changes code ends' : ''
  return { ok: true, text: `Recorded iron rule [${input.id}] ${input.title}${merged}${enforced}.` }
}

/** Model-facing guidance; deliberately narrow so ordinary advice is not captured as a rule. */
const TOOL_DESCRIPTION =
  'Record a development rule as binding for this repository.\n\n'
  + 'RECORD ONLY ON A TRIGGER — never speculatively:\n'
  + '1. After an incident: something broke, and a rule would have prevented it.\n'
  + '2. The same mistake twice.\n'
  + '3. Someone states a requirement outright ("from now on always…", "this is an iron rule", '
  + '"write this down so it never happens again") — no need to wait for it to bite.\n'
  + 'A rule nobody has confirmed matters is speculation. This bans guessing at rules '
  + 'that MIGHT matter, not recording ones someone has confirmed DO matter but has not '
  + 'been burned by yet. Never use this to summarize advice, preferences, or your own '
  + 'conclusions.\n\n'
  + 'The rule is written to the repository and enters every later session of this '
  + 'project, so a wrong capture is durable and expensive. Before calling:\n'
  + '- READ the relevant code. Write the rule as it actually applies HERE — what it '
  + 'forbids, what to do instead, any legitimate exception — rather than restating the '
  + 'request in the requester\'s words.\n'
  + '- If the request is too vague to name a concrete rule, ask for specifics instead '
  + 'of guessing. An empty capture beats a wrong one.\n'
  + '- Compare against the existing rules. If two or more of them already cover this '
  + 'concern, MERGE: write the combined rule and list them in `replaces`, rather than '
  + 'adding one more. If this only refines a single existing rule, revise it the same '
  + 'way — `replaces: ["<that id>"]`. Recording a near-duplicate is the one outcome to '
  + 'avoid; the rule set has to be able to shrink.'

/** Render intent of one recording call: a generic card titled by the rule. */
export function presentRecordCall(args: { id: string; title: string }): { card: 'generic'; title: string; kind: 'other'; rawInput: string } {
  return { card: 'generic', title: `Record iron rule [${args.id}]`, kind: 'other', rawInput: args.title }
}

/**
 * Mount the recording entry points: the model-facing tool and the
 * `devflowIronRules` service other plugins forward an obligation to.
 *
 * The tool registry gets a CONDITIONAL child (`ctx.inject`) rather than a
 * declared injection or a `ctx.get()` read. A declared injection would hold
 * the whole plugin — including enforcement — hostage to a tool surface it does
 * not need. A `ctx.get()` read samples the service store at `apply()` time,
 * and the Loader activates rows concurrently: losing that race registers
 * nothing, forever, with no diagnostic. The child activates whenever the
 * registry is composed and unwinds with it.
 * @param ctx - the cordis context the plugin is mounted on.
 * @param config - the resolved plugin configuration.
 */
export function applyRecord(ctx: Context, config: ResolvedConfig): void {
  ctx.effect(() => ctx.provide('devflowIronRules', {
    record: async (agent: Agent, input: RecordInput) => await recordRule(ctx, agent, input, config),
  }))

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(defineTool({
      name: 'devflow_record_iron_rule',
      description: TOOL_DESCRIPTION,
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Directory name for the rule: lowercase letters, digits, and hyphens (e.g. "no-any-in-src").',
        },
        title: {
          type: 'string',
          required: true,
          description: 'The rule as one imperative sentence.',
        },
        body: {
          type: 'string',
          required: true,
          description:
            'The rule in four parts, in this order: (1) the ban as ONE bolded sentence — bold so it stays greppable; '
            + '(2) why — the incident or requirement behind it, and why tests missed it; (3) the correct form — show the fix, not just the ban; '
            + '(4) enforcement — name `check.sh`, or state why only judgement can decide this.',
        },
        enforcement: {
          type: 'string',
          required: true,
          enum: ['script', 'judgement'],
          description:
            'Triage: can a script decide a violation? "script" REQUIRES both `check` and `watches`. "judgement" forbids `check` '
            + 'and requires part (4) of the body to say why no script can decide it. Answer honestly — a rule set where everything '
            + 'is "judgement" enforces nothing, and a check that cannot decide reliably is worse than none.',
        },
        check: {
          type: 'string',
          description: 'Shell script verifying the rule, for `enforcement: "script"` only. Runs with bash from the session workspace root; prints the offending file and line on stdout and exits non-zero when violated; must modify nothing.',
        },
        watches: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Workspace-relative path prefixes the check script looks at (e.g. ["src/", "packages/api/"]). Required for '
            + '`enforcement: "script"`. It is how a later session detects that the script has gone stale: once every one of these '
            + 'paths is gone, the script can only ever pass, and a check that cannot fail is worse than no check.',
        },
        replaces: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ids of existing rules this one replaces; they are deleted (git keeps the history). One id revises a rule in place. '
            + 'SEVERAL merges a cluster — use it when two or more existing rules say the same thing, rather than adding a third. '
            + 'This is the only way the rule set shrinks. Team (admin) rules cannot be replaced.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            recorded: { type: 'boolean', required: true },
            detail: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.detail }],
      },
      async execute(args, exec) {
        if (!exec.agent) {
          // Rules are written into the calling session's workspace; a caller
          // without one has no repository to write to.
          throw new Error('devflow_record_iron_rule requires an owning agent session')
        }
        const outcome = await recordRule(ctx, exec.agent, {
          id: args.id,
          title: args.title,
          body: args.body,
          enforcement: args.enforcement === 'script' ? 'script' : 'judgement',
          ...args.check !== undefined ? { check: args.check } : {},
          ...args.watches !== undefined ? { watches: args.watches } : {},
          ...args.replaces !== undefined ? { replaces: args.replaces } : {},
        }, config)
        return { id: args.id, recorded: outcome.ok, detail: outcome.text }
      },
      presentCall: presentRecordCall,
    }))
  })
}
