/** Resolve configuration in assembly so the very first model request receives current guidance. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export function registerGuidance(ctx: Context): void {
  ctx.systemPrompt.context({ name: 'devflow-jev-usage', order: 230, text: '' })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const entry = assembly.contexts.find(context => context.name === 'devflow-jev-usage')
    if (entry === undefined || agent === undefined || agent.session.header.cwd === undefined) return assembly
    const visible = (name: string): boolean => ctx.tools.get(name, agent) !== undefined
    if (!visible('devflow_assess')) return assembly
    let status
    try {
      status = await ctx.jev.configurationStatus()
    } catch {
      // Resolver failures suppress guidance; their causes can contain credential material.
      return assembly
    }
    if (status !== 'configured') return assembly
    entry.text = [
      'Devflow JEV guidance: the provider credential is configured locally, not remotely verified. Use evidence-based assessments naturally when material development decisions need another judgement.',
      'Inspect the current request, existing cards and relevant implementation before assessment. For a nontrivial proposed request use devflow_assess target=request with title and body; for an existing card use target=card with id and assessmentKind.',
      'Choose the relevant assessmentKind: intake or planning for uncertain scope; implementation-risk for risky design; test-impact or review-scope for changed behavior; spec-delta for contract drift; release-readiness before delivery when risks remain. Persist current evidence on the card before assessing it.',
      'Skip trivial work and duplicate assessments of unchanged evidence. Reuse the existing card rather than creating another. An assessment records advice and never advances stages; scores are not test results or authorization to bypass gates. If assessment fails, report missing judgement and avoid repeated retries without a changed cause.',
      ...(visible('devflow_decide_judgement') ? ['Use devflow_decide_judgement with id and action accept or reject only when deciding an assessed request within the user-authorized scope. Accept creates a card, so check for an existing card first; never accept solely because a score is high.'] : []),
      ...(visible('jev_list') ? ['Use jev_list source=devflow-assessment (and id for detail) to inspect existing assessments.'] : []),
      ...(visible('jev_list') && ctx.get('devflowAssistance') !== undefined ? ['Automatic development assistance is recorded separately. Use jev_list source=devflow-assistance to inspect triggers, advice delivery and later observed actions; an observed check is not proof that advice caused a fix.'] : []),
      ...(visible('jev_run') && visible('jev_list') && ctx.get('jevRuns') !== undefined ? ['For a broad project delivery audit, use jev_run source=devflow-audit with profile delivery-health, release, risk, spec or full and optional maxCards. This reviews Devflow records and their evidence, not every source file; use a generic evidence-backed review for code outside that scope. Track the audit with jev_list source=devflow-audit.'] : []),
    ].join('\n')
    return assembly
  })
}
