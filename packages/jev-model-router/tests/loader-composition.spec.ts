// REAL-composition proof: a cordis.yml booted through the actual Loader mounts
// the tools registry, the real system-prompt service, an in-memory judgement,
// and this plugin — then drives a delegation through the registry's own policy
// pipeline and reads the prompt the deployment would actually assemble.
//
// The judgement is the only double. The two failures unit tests cannot see are
// both here: a `tools/pre-execute` denial that the real registry does not turn
// into a model-visible error, and an ordered context that the real
// system-prompt service never asks this plugin to fill.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Router from '@zhchxiao123/dsh-jev-model-router'
import { CONTEXT_NAME, QUESTION_KEY } from '@zhchxiao123/dsh-jev-model-router'
import {
  MemoryJev, TIERS, delegationTool, listModelsTool, scoreAnswer, testAgent,
} from './doubles.ts'
import type { DelegationCall } from './doubles.ts'

const cleanups: (() => Promise<unknown>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function boot(): Promise<{ ctx: Context; jev: MemoryJev; calls: DelegationCall[] }> {
  const base = await mkdtemp(join(tmpdir(), 'jev-model-router-loader-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))

  const configPath = join(base, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'memory-jev'",
    "- name: 'delegation-tools'",
    "- name: '@zhchxiao123/dsh-jev-model-router'",
    '  config:',
    '    tools: [subagent]',
    '    tiers:',
    ...TIERS.flatMap(tier => [
      `      - key: ${String(tier.key)}`,
      `        when: ${JSON.stringify(tier.when)}`,
      `        provider: ${String(tier.provider)}`,
      `        model: ${String(tier.model)}`,
      ...tier.reasoningEffort === undefined ? [] : [`        reasoningEffort: ${tier.reasoningEffort}`],
    ]),
    '',
  ].join('\n'))

  const calls: DelegationCall[] = []
  // The delegation tool and the route catalog stand in for the harness
  // packages this line does not depend on; they are mounted as one Loader row
  // so the composition, not the spec body, is what registers them.
  const delegationTools = {
    name: 'delegation-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.tools.register(delegationTool(calls)))
      ctx.effect(() => ctx.tools.register(listModelsTool()))
    },
  }

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(base).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['memory-jev', MemoryJev],
    ['delegation-tools', delegationTools],
    ['@zhchxiao123/dsh-jev-model-router', Router],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return await Promise.resolve(modules.get(specifier))
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, jev: ctx.get('jev') as MemoryJev, calls }
}

describe('jev-model-router composed through the real Loader', () => {
  it('turns a disagreeing route into an error the model reads, and the retry through', async () => {
    const { ctx, jev, calls } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(2) } })
    const agent = testAgent({ provider: 'p', model: 'medium' })
    const work = { description: 'Plan the migration', prompt: 'Plan a zero-downtime migration of the session store.' }

    const refused = await ctx.tools.execute({
      name: 'subagent',
      arguments: { ...work, provider: 'p', model: 'small' },
      callId: ToolCallId('loader-delegate-1'),
      signal: new AbortController().signal,
      agent,
    })
    expect(refused.isError).toBe(true)
    const reason = refused.content.map(block => ('text' in block ? block.text : '')).join('\n')
    expect(reason).toContain('provider "p" and model "large"')
    expect(calls).toHaveLength(0)

    const accepted = await ctx.tools.execute({
      name: 'subagent',
      arguments: { ...work, provider: 'p', model: 'large' },
      callId: ToolCallId('loader-delegate-2'),
      signal: new AbortController().signal,
      agent,
    })
    expect(accepted.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toMatchObject({ model: 'large' })
  })

  it('assembles the tier table into the prompt the deployment would send', async () => {
    const { ctx } = await boot()
    const assembly = await ctx.systemPrompt.assemble({ agent: testAgent() })
    const entry = assembly.contexts.find(item => item.name === CONTEXT_NAME)
    expect(entry?.text).toContain('always set `provider` and `model` explicitly')
    expect(entry?.text).toContain('deep (provider "p", model "large", reasoning_effort "high")')
    expect(entry?.text).toContain('refused once with the tier to use')
  })

  it('reads its tier list from the composition, not from a default', async () => {
    const { ctx, jev } = await boot()
    jev.setScript({ answers: { [QUESTION_KEY]: scoreAnswer(0) } })
    await ctx.tools.execute({
      name: 'subagent',
      arguments: { prompt: 'Rename one local variable.', provider: 'p', model: 'small' },
      callId: ToolCallId('loader-delegate-3'),
      signal: new AbortController().signal,
      agent: testAgent(),
    })
    expect(jev.calls[0]?.questions[QUESTION_KEY]).toMatchObject({
      type: 'score',
      criteria: TIERS.map(tier => tier.when),
    })
  })
})
