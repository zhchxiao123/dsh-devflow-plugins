/**
 * The three model-facing tools over per-workspace engines: `deploy_target`,
 * `deploy_status`, and `deploy_rollback`. Each resolves the caller's workspace
 * root from its agent session's working directory — never from the harness
 * process cwd, which in a long-lived deployment points at the harness checkout.
 *
 * Nothing here names a deployment kind. The phase vocabulary is closed and the
 * registry does the dispatch, so a new kind reaches the model through these
 * same three tools with these same renders.
 *
 * Manifest defects reach the model with every field-path issue plus the
 * pointer to the `deploy-bootstrap` skill, which owns writing and repairing
 * `deploy.yml`. The engine writes no skill prose; appending it belongs here so
 * that reusing the engine behind another face cannot misattribute the advice.
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { DeployEngine, DeployReport, StatusReport } from './engine.ts'
import { ManifestError } from './manifest.ts'
import { UnknownKindError } from './registry.ts'

/** The model-facing pointer from a manifest defect to its repair loop. */
const BOOTSTRAP_GUIDANCE
  = 'Run the `deploy-bootstrap` skill to survey what this project publishes and to write or repair deploy.yml.'

/** Resolves the engine serving one workspace root. */
export type EngineResolver = (root: string) => DeployEngine

/**
 * The workspace root behind one execution, resolved fresh per call.
 * @param exec - the tool execution context.
 * @returns the absolute workspace root.
 * @throws {Error} when the call carries no session working directory; the
 *   harness process cwd is deliberately not a fallback.
 */
function callerRoot(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) {
    throw new Error(
      'deploy resolves the workspace root from the calling agent session\'s working directory, '
      + 'and this call carries none — either the caller has no owning agent session, or its session '
      + 'was created without a cwd. The harness process cwd is not a fallback: in a long-lived '
      + 'deployment it points at the harness checkout, not the caller\'s workspace. Call the deploy '
      + 'tools from an agent session created with a workspace working directory.',
    )
  }
  return resolve(cwd)
}

/** Append the repair pointer to the defects the skill owns; every other failure passes through. */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof ManifestError || error instanceof UnknownKindError) {
      throw new Error(`${error.message}\n\n${BOOTSTRAP_GUIDANCE}`)
    }
    throw error
  }
}

const PHASE_TIMING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    phase: { type: 'string', required: true },
    durationMs: { type: 'integer', required: true },
  },
} as const

const DEPLOY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    kind: { type: 'string', required: true, description: 'The target kind whose driver executed this.' },
    releaseId: { type: 'string', required: true, description: 'Identifier of the release now serving; opaque, and defined by the kind.' },
    url: { type: 'string', description: 'Where the target can be reached, when its kind has an address.' },
    durationMs: { type: 'integer', required: true },
    phases: { type: 'array', required: true, items: PHASE_TIMING },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal defects; the deploy still succeeded.' },
  },
} as const

const RELEASE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    current: { type: 'boolean', required: true },
  },
} as const

const TARGET_STATUS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    rollback: {
      type: 'string',
      required: true,
      enum: ['atomic', 'disruptive', 'unsupported'],
      description: 'What this target\'s kind promises about returning to a previous release.',
    },
    rollbackNote: { type: 'string', description: 'Why a rollback interrupts service, or why none is promised.' },
    currentRelease: { type: 'string', description: 'Absent when nothing has been deployed yet.' },
    url: { type: 'string' },
    releases: { type: 'array', required: true, items: RELEASE, description: 'Newest first, as the kind\'s driver ordered them.' },
  },
} as const

const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    targets: { type: 'array', required: true, items: TARGET_STATUS },
    durationMs: { type: 'integer', required: true },
  },
} as const

interface DeployValue {
  target: string
  kind: string
  releaseId: string
  url?: string
  durationMs: number
  phases: { phase: string; durationMs: number }[]
  warnings?: string[]
}

interface StatusValue {
  targets: {
    name: string
    kind: string
    rollback: 'atomic' | 'disruptive' | 'unsupported'
    rollbackNote?: string
    currentRelease?: string
    url?: string
    releases: { id: string; current: boolean }[]
  }[]
  durationMs: number
}

function projectDeploy(report: DeployReport): DeployValue {
  return {
    target: report.target,
    kind: report.kind,
    releaseId: report.outcome.releaseId,
    ...report.outcome.url === undefined ? {} : { url: report.outcome.url },
    durationMs: report.durationMs,
    phases: report.timeline.map(entry => ({ phase: entry.phase, durationMs: entry.durationMs })),
    ...report.warnings.length === 0 ? {} : { warnings: [...report.warnings] },
  }
}

function projectStatus(report: StatusReport): StatusValue {
  return {
    targets: report.targets.map(target => ({
      name: target.name,
      kind: target.kind,
      rollback: target.rollbackClass.kind,
      ...target.rollbackClass.kind === 'disruptive'
        ? { rollbackNote: target.rollbackClass.note }
        : target.rollbackClass.kind === 'unsupported'
          ? { rollbackNote: target.rollbackClass.reason }
          : {},
      ...target.currentRelease === undefined ? {} : { currentRelease: target.currentRelease },
      ...target.url === undefined ? {} : { url: target.url },
      releases: target.releases.map(release => ({ id: release.id, current: release.current })),
    })),
    durationMs: report.durationMs,
  }
}

/** The phase timeline, one line per phase, in the order the run passed through them. */
function phaseLines(phases: readonly { phase: string; durationMs: number }[]): readonly string[] {
  return phases.map(entry => `  ${entry.phase}: ${entry.durationMs}ms`)
}

function deployRender(verb: string, value: DeployValue): string {
  return [
    `${verb} ${value.target} to release ${value.releaseId} in ${value.durationMs}ms.`,
    ...value.url === undefined ? [] : [`Reachable at ${value.url}`],
    ...phaseLines(value.phases),
    ...value.warnings === undefined ? [] : ['Warnings:', ...value.warnings.map(warning => `  ${warning}`)],
  ].join('\n')
}

function statusRender(value: StatusValue): string {
  if (value.targets.length === 0) return 'deploy.yml declares no targets.'
  return value.targets.flatMap((target) => {
    const head = target.currentRelease === undefined
      ? `${target.name} (${target.kind}): nothing deployed yet.`
      : `${target.name} (${target.kind}): release ${target.currentRelease}${target.url === undefined ? '' : ` at ${target.url}`}`
    const rollback = target.rollbackNote === undefined
      ? `  rollback: ${target.rollback}`
      : `  rollback: ${target.rollback} — ${target.rollbackNote}`
    const history = target.releases.length <= 1
      ? []
      : [`  earlier releases: ${target.releases.filter(release => !release.current).map(release => release.id).join(', ')}`]
    return [head, rollback, ...history]
  }).join('\n')
}

/**
 * Register the three deploy tools over a lazily-built map of one engine per
 * workspace root.
 * @param ctx - registrant context carrying the tool registry.
 * @param engines - resolves the engine serving one workspace root.
 */
export function registerTools(ctx: Context, engines: EngineResolver): void {
  ctx.tools.register(defineTool({
    name: 'deploy_target',
    description:
      'Publish one target declared in this project\'s deploy.yml so that it outlives this session: '
      + 'the target\'s build runs, the result becomes a new release, and the target switches to it. '
      + 'Returns the release identifier, where the target can now be reached, and how long each phase '
      + 'took. Nothing on the far side changes until preflight has passed, so a failure before that '
      + 'leaves what is live untouched. Use deploy_status to see what is live and deploy_rollback to '
      + 'go back. If there is no valid deploy.yml yet, run the deploy-bootstrap skill to write one.',
    parameters: {
      target: { type: 'string', required: true, description: 'Name of a target declared under `targets` in deploy.yml.' },
    },
    output: {
      schema: DEPLOY_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: deployRender('Deployed', value) }],
    },
    async execute(args, exec) {
      const engine = engines(callerRoot(exec))
      return projectDeploy(await guarded(() => engine.deploy(args.target)))
    },
    presentCall: args => ({ card: 'generic', title: `Deploy ${args.target}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'deploy_status',
    description:
      'Report what is currently published for one target, or for every target declared in deploy.yml: '
      + 'the release now serving, where it can be reached, the earlier releases still available, and '
      + 'what that target\'s kind promises about rolling back — atomic, disruptive, or unsupported. '
      + 'Read the rollback promise before planning a rollback: some kinds cannot offer one.',
    parameters: {
      target: { type: 'string', description: 'One target name; omitted reports every declared target.' },
    },
    output: {
      schema: STATUS_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: statusRender(value) }],
    },
    async execute(args, exec) {
      const engine = engines(callerRoot(exec))
      return projectStatus(await guarded(() => engine.status(args.target)))
    },
    presentCall: args => ({
      card: 'generic',
      title: args.target === undefined ? 'Report every deployed target' : `Report ${args.target}`,
      kind: 'read',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'deploy_rollback',
    description:
      'Return one target to an earlier release without rebuilding or re-transferring it. Defaults to '
      + 'the release before the current one; name a release to go further back. Fails loud, and '
      + 'without touching the far side, when the target\'s kind promises no rollback — check '
      + 'deploy_status first, which reports that promise per target.',
    parameters: {
      target: { type: 'string', required: true, description: 'Name of a target declared under `targets` in deploy.yml.' },
      to: { type: 'string', description: 'Release identifier to return to; omitted uses the one before the current release.' },
    },
    output: {
      schema: DEPLOY_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: deployRender('Rolled back', value) }],
    },
    async execute(args, exec) {
      const engine = engines(callerRoot(exec))
      return projectDeploy(await guarded(() => engine.rollback(args.target, args.to)))
    },
    presentCall: args => ({ card: 'generic', title: `Roll back ${args.target}`, kind: 'execute' }),
  }))
}
