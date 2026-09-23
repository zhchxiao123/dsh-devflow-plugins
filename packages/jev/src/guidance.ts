/** Resolve configuration in assembly so the very first model request receives current guidance. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export function registerGuidance(ctx: Context): void {
  ctx.systemPrompt.context({ name: 'jev-usage', order: 220, text: '' })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const entry = assembly.contexts.find(context => context.name === 'jev-usage')
    if (entry === undefined || agent === undefined || agent.session.header.cwd === undefined) return assembly
    const visible = (name: string): boolean => ctx.tools.get(name, agent) !== undefined
    if (!visible('jev_run')) return assembly
    let status
    try {
      status = await ctx.jev.configurationStatus()
    } catch {
      // Resolver failures suppress guidance; their causes can contain credential material.
      return assembly
    }
    if (status !== 'configured') return assembly
    entry.text = [
      'JEV review guidance: the provider credential is configured locally; remote authentication and availability are not verified.',
      'Use JEV proactively for material uncertainty in nontrivial development: ambiguous requirements, risky design or state/concurrency/compatibility changes, and unresolved review or release risks before delivery. The user need not name JEV.',
      'First inspect the relevant source, requirements, diff and actual test results. Ask concrete evidence-answerable questions; include bounded evidence with paths, revisions and limitations. A generic run does not read files or scan the repository for you.',
      'Use jev_run with title, evidence and questions (an array of yes/no questions); source defaults to generic. Use definitionJson only when typed questions or multiple subjects require JevRunDefinition. Do not combine the two input forms.',
      'Skip trivial edits and questions already resolved by reliable evidence. Do not run on every step or repeat unchanged evidence. Use findings to adjust implementation or verification; report remaining uncertainty.',
      'Judgements are advice, not test results or permission to bypass workflow gates. A missing or failed judgement is not a pass: report it, continue permitted work, and avoid repeated retries without a changed cause.',
      ...(visible('jev_list') ? ['Use jev_list to find existing reviews before starting another; inspect details with source and id. Reuse relevant completed findings and inspect running jobs instead of duplicating them.'] : []),
      ...(visible('jev_control') ? ['Use jev_control with source, id and action resume or cancel for interrupted or unwanted runs; resume preserves completed checks.'] : []),
      ...(visible('jev_triage') ? ['Use jev_triage for tracked changed-file risk before code review when prioritization helps. Check git status separately for untracked files; triage does not replace reviewing code or running tests.'] : []),
    ].join('\n')
    return assembly
  })
}
