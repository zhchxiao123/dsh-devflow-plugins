/** Real browser/SDK/attachment/LLM composition; only the paid provider response is controlled. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { startDshModelBridge } from '../src/model-bridge.ts'
import { runAcceptance } from '../src/runner.ts'
import { startModelFixture } from './support.ts'

it('accepts a real Chromium screenshot through DSH and retains task-linked report evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'midscene-dsh-bridge-'))
  const ctx = new Context()
  const fixture = await startModelFixture()
  const workspace = join(root, 'workspace')
  const exec = promisify(execFile)
  let images = 0
  let calls = 0
  try {
    await exec('git', ['init', '-q', workspace])
    await exec('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'home') }).await()
    await ctx.plugin(LlmRuntime).await()
    class ControlledProvider extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
      }
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        calls++
        for (const message of options.messages) for (const block of message.content) {
          if (block.type !== 'image') continue
          const image = await ctx.attachments.readImage(block.attachment)
          expect(image.data.length).toBeGreaterThan(100)
          expect(image.ref.width).toBeGreaterThan(100)
          expect(image.ref.height).toBeGreaterThan(100)
          expect(image.ref.originalDimensions).toBeUndefined()
          images++
        }
        const text = '<observation>Controlled transport fixture, not a visual accuracy claim.</observation><data-json>{"StatementIsTruthy":true}</data-json>'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['configured'], new ControlledProvider())
    const bridge = await startDshModelBridge(ctx, { provider: 'configured', model: 'gpt-5', family: 'gpt-5' })
    const suite = join(workspace, '.devflow', 'midscene', 'suites', 'acceptance.json')
    await mkdir(dirname(suite), { recursive: true })
    await writeFile(suite, JSON.stringify({ version: 1, name: 'DSH model reuse', baseUrl: fixture.baseUrl, buildProbe: { path: '/build', expected: 'fixture-build' }, cases: [{ id: 'heading', steps: [{ kind: 'goto', path: '/' }, { kind: 'assert', prompt: 'Heading Acceptance fixture is visible' }] }] }))
    const result = await runAcceptance({ suite, workspace, output: join(root, 'reports'), card: '001-dsh-reuse', buildId: 'fixture-build', model: 'gpt-5', timeoutMs: 25000, cleanupTimeoutMs: 3000, maxSteps: 5, environment: bridge.environment, ...(process.env.MIDSCENE_TEST_BROWSER ? { executablePath: process.env.MIDSCENE_TEST_BROWSER } : {}) })
    expect(result.status, JSON.stringify(result)).toBe('passed')
    expect(images).toBeGreaterThan(0)
    expect(calls).toBeGreaterThan(0)
    expect(fixture.state.requests).toBe(0)
    expect(result.counts.passedAssertions).toBe(1)
    expect(result.card).toBe('001-dsh-reuse')
    const report = await readFile(join(root, 'reports', result.runId, 'case-0.html'), 'utf8')
    expect(report).not.toContain(bridge.environment.MIDSCENE_MODEL_API_KEY)
    await bridge.dispose()
  } finally { await ctx.fiber.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }) }
}, 60000)
