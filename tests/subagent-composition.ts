/**
 * What a composition must mount before `ctx.subagents` exists, stated once.
 *
 * `SubagentRuntime.inject` is `['workingDirectory']`, and
 * `WorkingDirectoryService.inject` is `['fs', 'sessionProjections',
 * 'systemPrompt']`. A Session owns its working directory now, so the
 * delegation service cannot resolve a child's workspace without that chain —
 * a composition missing any link leaves `ctx.subagents` undefined, which
 * surfaces as `Cannot read properties of undefined (reading
 * 'registerProvider')` rather than as a missing dependency.
 *
 * Both shapes live here because the specs use both: a real `cordis.yml` driven
 * through the Loader, and direct `ctx.plugin()` mounting.
 * @module tests/subagent-composition
 */

import type { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'

/** `cordis.yml` rows the delegation service needs, in dependency order. */
export const SUBAGENT_ROWS: readonly string[] = [
  "- name: '@deepseek-ai/dsh-fs-local'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-working-directory'",
  "- name: '@deepseek-ai/dsh-subagent'",
]

/** The same packages as Loader module-table entries. */
export const SUBAGENT_MODULES: readonly (readonly [string, unknown])[] = [
  ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
  ['@deepseek-ai/dsh-session-projection', SessionProjections],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
  ['@deepseek-ai/dsh-subagent', SubagentRuntime],
]

/**
 * Mount the delegation service and its dependency chain directly.
 *
 * Each link is skipped when the service is already present: a spec that mounts
 * `systemPrompt` itself — to register tools against it, say — would otherwise
 * fail on `service "systemPrompt" has been registered`, and making every
 * caller track which links it already owns is the bookkeeping this helper
 * exists to remove.
 * @param ctx - the composing context.
 * @returns resolves once `ctx.subagents` is available.
 */
export async function mountSubagentRuntime(ctx: Context): Promise<void> {
  if (ctx.get('fs') === undefined) await ctx.plugin(LocalFileSystem)
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjections)
  if (ctx.get('systemPrompt') === undefined) await ctx.plugin(SystemPrompt)
  if (ctx.get('workingDirectory') === undefined) await ctx.plugin(WorkingDirectoryService)
  await ctx.plugin(SubagentRuntime).await()
}
