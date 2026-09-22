// The tool as a model reaches it, composed with an in-memory judgement and a
// scripted shell.
//
// Nothing in this file names a provider package, and neither does the rest of
// this directory: mounting a different backend is what a spec does here by
// default, so "the consumer does not know who answers" is a property the suite
// exercises rather than one the design merely claims.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Triage from '@zhchxiao123/dsh-jev-triage'
import { MemoryJev, ScriptedShell, scoreAnswer, textDiff } from './doubles.ts'

async function boot(config: Parameters<typeof Triage.apply>[1] = {}): Promise<{
  ctx: Context
  jev: MemoryJev
  shell: ScriptedShell
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(MemoryJev)
  await ctx.plugin(ScriptedShell)
  await ctx.plugin(Triage, config)
  return { ctx, jev: ctx.jev as MemoryJev, shell: ctx.shell as ScriptedShell }
}

function call(ctx: Context, args: Record<string, unknown>, signal = new AbortController().signal) {
  return ctx.tools.execute({
    name: 'jev_triage',
    arguments: args,
    callId: ToolCallId('triage-1'),
    signal,
  })
}

describe('jev_triage', () => {
  it('registers under a name the model can call', async () => {
    const { ctx } = await boot()
    expect(ctx.tools.get('jev_triage')).toBeDefined()
  })

  it('scores each changed file and reports the split', async () => {
    const { ctx, jev, shell } = await boot()
    shell.setOutcome({ stdout: `${textDiff('docs/readme.md')}\n${textDiff('src/auth.ts')}` })
    jev.setScript({ answers: { f0: scoreAnswer(0, 0.95), f1: scoreAnswer(3, 0.9) } })
    const result = await call(ctx, { cwd: '/repo' })
    expect(result.isError).toBeFalsy()
    const text = result.content.map(block => ('text' in block ? block.text : '')).join('\n')
    expect(text).toContain('1 to review, 1 skipped')
    expect(text).toContain('SKIP  docs/readme.md')
    expect(text).toContain('REVIEW  src/auth.ts')
  })

  it('passes the ref through to git when one is given', async () => {
    const { ctx, shell } = await boot()
    shell.setOutcome({ stdout: '' })
    await call(ctx, { cwd: '/repo', base: 'main' })
    expect(shell.commands[0]).toContain("'main'")
  })

  it('reports unavailable rather than judging a path it cannot trust', async () => {
    const { ctx, jev } = await boot()
    const result = await call(ctx, { cwd: 'relative/path' })
    const text = result.content.map(block => ('text' in block ? block.text : '')).join('\n')
    expect(text).toContain('Treat every changed file as needing review.')
    expect(jev.calls).toHaveLength(0)
  })

  it('reports unavailable when git could not produce a complete diff', async () => {
    const { ctx, jev, shell } = await boot()
    shell.setOutcome({ stdout: textDiff('a.ts'), truncated: true })
    const result = await call(ctx, { cwd: '/repo' })
    const text = result.content.map(block => ('text' in block ? block.text : '')).join('\n')
    expect(text).toContain('jev_triage is unavailable')
    expect(text).toContain('Treat every changed file as needing review.')
    // Half a diff is never judged: it would score as though it were the change.
    expect(jev.calls).toHaveLength(0)
  })

  it('honours a configured rubric and skip line', async () => {
    const { ctx, jev, shell } = await boot({ scoreLevels: ['Safe: nothing.', 'Unsafe: something.'], skipBelow: 1 })
    shell.setOutcome({ stdout: textDiff('a.ts') })
    jev.setScript({ answers: { f0: scoreAnswer(0, 0.99) } })
    const result = await call(ctx, { cwd: '/repo' })
    const text = result.content.map(block => ('text' in block ? block.text : '')).join('\n')
    expect(text).toContain('SKIP  a.ts  score 0 (safe)')
    expect((jev.calls[0]?.questions.f0 as { criteria: string[] }).criteria).toHaveLength(2)
  })

  it('refuses a rubric that cannot discriminate, at load', async () => {
    await expect(boot({ scoreLevels: ['only one'] })).rejects.toThrow('at least two levels')
  })

  it('unregisters the tool with the fiber that registered it', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(MemoryJev)
    await ctx.plugin(ScriptedShell)
    const fiber = await ctx.plugin(Triage, {})
    expect(ctx.tools.get('jev_triage')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('jev_triage')).toBeUndefined()
  })

  it('presents the call as a read, naming what it covers', async () => {
    const { ctx } = await boot()
    const definition = ctx.tools.get('jev_triage')
    expect(definition?.presentCall?.({ cwd: '/repo' })).toMatchObject({ kind: 'read', rawInput: '/repo' })
    expect(definition?.presentCall?.({ cwd: '/repo', base: 'main' })).toMatchObject({ rawInput: '/repo (vs main)' })
  })
})
