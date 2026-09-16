import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setMidsceneRunDir } from '@midscene/shared/common'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { checkDshModel, inferMidsceneFamily, startDshModelBridge, type DshModelBridge } from '../src/model-bridge.ts'

const selected = { provider: 'configured', model: 'gpt-5', family: 'gpt-5' }
const bridges: DshModelBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.dispose())); vi.restoreAllMocks() })
function setup() {
  const ctx = new Context()
  const stream = vi.fn(async function* (_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
    yield { type: 'reasoning-delta', index: 1, text: 'checked' }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const info = vi.fn(async () => ({ inputModalities: ['text', 'image'] }))
  const prepare = vi.fn(async (config: unknown) => ({ config, inputModalities: ['image'], stream }))
  const saveImage = vi.fn(async () => ({ attachmentId: 'image-id', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }))
  ctx.provide('llm', { resolveModelInfo: info, prepareCall: prepare })
  ctx.provide('attachments', { saveImage })
  return { ctx, stream, info, prepare, saveImage }
}
async function start(ctx: Context, signal?: AbortSignal) {
  const bridge = await startDshModelBridge(ctx, selected, signal)
  bridges.push(bridge)
  return bridge
}
function request(bridge: DshModelBridge, body: unknown, auth = bridge.environment.MIDSCENE_MODEL_API_KEY) {
  return fetch(`${bridge.environment.MIDSCENE_MODEL_BASE_URL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) })
}
const input = { model: 'gpt-5', messages: [{ role: 'user', content: 'inspect' }] }
it('routes actual HTTP through DSH with immutable model, images, usage, and no provider credentials', async () => {
  const { ctx, stream, prepare, saveImage } = setup()
  const bridge = await start(ctx)
  const response = await request(bridge, { ...input, temperature: 0, max_tokens: 100, stop: ['end'], messages: [{ role: 'system', content: 'inspect UI' }, { role: 'assistant', content: 'ready' }, { role: 'user', content: [{ type: 'text', text: 'find' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'high' } }] }] })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ choices: [{ message: { content: '{"ok":true}', reasoning_content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })
  expect(prepare).toHaveBeenCalledWith({ provider: 'configured', model: 'gpt-5', temperature: 0, maxTokens: 100, stop: ['end'] }, expect.any(AbortSignal))
  expect(stream.mock.calls[0]![0].messages[2]!.content[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'image-id' } })
  expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from('abc'), mediaType: 'image/png' })
  expect(bridge.redact(`Bearer ${bridge.environment.MIDSCENE_MODEL_API_KEY}`)).not.toContain(bridge.environment.MIDSCENE_MODEL_API_KEY)
  expect(bridge.environment.MIDSCENE_MODEL_RESPONSE_FORMAT).toBe('none')
})
it('authenticates only the run token and only serves the completion endpoint', async () => {
  const { ctx, prepare } = setup(); const bridge = await start(ctx)
  expect((await request(bridge, input, 'wrong')).status).toBe(401)
  expect((await fetch(bridge.environment.MIDSCENE_MODEL_BASE_URL!)).status).toBe(404)
  expect(prepare).not.toHaveBeenCalled()
})
it('returns OpenAI streaming framing, length finish and exact provider totals', async () => {
  const { ctx, stream } = setup()
  stream.mockImplementation(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })
  const response = await request(await start(ctx), { ...input, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 5, stop: 'end' })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const text = await response.text()
  expect(text).toContain('"finish_reason":"length"'); expect(text).toContain('"total_tokens":7'); expect(text).toContain('data: [DONE]')
})
it.each([
  null, [], {}, { ...input, model: 'other' }, { ...input, tools: [] }, { ...input, response_format: { type: 'json_object' } },
  { ...input, stream: 'true' }, { ...input, stream_options: { include_usage: false } }, { ...input, stream_options: null }, { ...input, stream_options: { other: true } },
  { ...input, temperature: 'hot' }, { ...input, max_tokens: 0 }, { ...input, max_tokens: 2, max_completion_tokens: 2 }, { ...input, stop: 4 }, { ...input, stop: [4] },
  { ...input, messages: [] }, { ...input, messages: 'bad' }, { ...input, messages: [null] }, { ...input, messages: [{ role: 'tool', content: 'x' }] },
  { ...input, messages: [{ role: 'user', content: null }] }, { ...input, messages: [{ role: 'user', content: [] }] },
  ...[
    { type: 'text', text: 3 }, { type: 'video' }, { type: 'image_url', image_url: null }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'image_url', image_url: { url: 3 } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'low' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJ' } },
  ].map(part => ({ ...input, messages: [{ role: 'user', content: [part] }] })),
])('rejects unrepresentable request semantics before calling a provider: %j', async (body) => {
  const { ctx, prepare } = setup(); const response = await request(await start(ctx), body)
  expect(response.status).toBe(502); expect(prepare).not.toHaveBeenCalled()
})
it('refuses resized screenshots rather than returning wrong coordinates', async () => {
  const { ctx, saveImage, prepare } = setup()
  saveImage.mockResolvedValue({ attachmentId: 'image-id', mediaType: 'image/png', bytes: 3, width: 1, height: 1, originalDimensions: { width: 2, height: 2 } } as Awaited<ReturnType<typeof saveImage>>)
  const response = await request(await start(ctx), { ...input, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] }] })
  expect(response.status).toBe(502); expect(prepare).not.toHaveBeenCalled()
})
it('refuses image capability changes between preflight and dispatch', async () => {
  const { ctx, prepare, stream } = setup()
  prepare.mockImplementation(async config => ({ config, inputModalities: ['text'], stream }))
  expect((await request(await start(ctx), input)).status).toBe(502); expect(stream).not.toHaveBeenCalled()
})
it.each(['missing', 'error', 'tool'] as const)('fails safely on %s output without reflecting adapter errors', async (mode) => {
  const { ctx, stream } = setup()
  stream.mockImplementation(async function* () {
    if (mode === 'error') throw new Error('SECRET-PROVIDER-KEY')
    if (mode === 'tool') yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  })
  const response = await request(await start(ctx), input)
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('SECRET-PROVIDER-KEY')
})
it('cancels in-flight provider requests and closes the ephemeral listener', async () => {
  const { ctx, stream } = setup(); const cancellation = new AbortController()
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve })
  let aborted = false
  stream.mockImplementation(async function* (options) {
    started()
    await new Promise<void>((resolve) => { options.signal!.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const bridge = await start(ctx, cancellation.signal)
  const pending = request(bridge, input).catch(() => undefined)
  await ready; cancellation.abort(); await bridge.dispose(); await pending
  expect(aborted).toBe(true)
  await expect(request(bridge, input)).rejects.toThrow()
})
it('checks services, canonical family and modality without a paid request', async () => {
  const { ctx, info, prepare } = setup()
  expect(await checkDshModel(ctx, selected)).toBe('available')
  info.mockResolvedValue({} as Awaited<ReturnType<typeof info>>)
  expect(await checkDshModel(ctx, selected)).toBe('unknown')
  info.mockResolvedValue({ inputModalities: ['text'] })
  await expect(checkDshModel(ctx, selected)).rejects.toThrow('rejects images')
  await expect(checkDshModel(ctx, { ...selected, family: 'invented' })).rejects.toThrow('family')
  await expect(checkDshModel(new Context(), selected)).rejects.toThrow('services')
  ctx.set('attachments', undefined)
  await expect(checkDshModel(ctx, selected)).rejects.toThrow('services')
  await expect(checkDshModel(ctx, selected, AbortSignal.abort())).rejects.toThrow()
  expect(prepare).not.toHaveBeenCalled()
})
it.each([['gpt-6.1','gpt-6'],['gpt-5','gpt-5'],['gpt-4o-mini',undefined],['qwen3-vl-235b','qwen3-vl'],['qwen2.5-vl-72b','qwen2.5-vl'],['gemini-3-pro','gemini'],['alias',undefined]])('maps canonical family %s without guessing aliases', (model,family) =>{  expect(inferMidsceneFamily(model)).toBe(family) })
it.each(['png', 'jpeg', 'webp', 'gif', 'svg'])('validates inline %s media at admission', async (extension) => {
  const { ctx } = setup(); const bridge = await start(ctx)
  const response = await request(bridge, { ...input, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/${extension};base64,YWJj`, detail: 'original' } }] }] })
  expect(response.status).toBe(extension === 'svg' ? 502 : 200)
})
it('bounds unaffordable request bodies before model dispatch', async () => {
  const { ctx, prepare } = setup(); const bridge = await start(ctx)
  const response = await request(bridge, { ...input, messages: [{ role: 'user', content: 'a'.repeat(32 * 1024 * 1024) }] })
  expect(response.status).toBe(502); expect(prepare).not.toHaveBeenCalled()
})
it('refuses unsuccessful finishes and streams sanitized errors after an earlier delta', async () => {
  const { ctx, stream } = setup(); const bridge = await start(ctx)
  stream.mockImplementation(async function* () { yield { type: 'finish', reason: { kind: 'tool-calls' } } })
  expect((await request(bridge, input)).status).toBe(502)
  stream.mockImplementation(async function* () {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield { type: 'reasoning-delta', index: 1, text: 'reason' }
    throw new Error('secret')
  })
  const response = await request(bridge, { ...input, stream: true })
  const text = await response.text()
  expect(text).toContain('partial'); expect(text).toContain('reason'); expect(text).toContain('model_bridge_error'); expect(text).not.toContain('secret')
})
it('allows unknown dispatched modality and reasoning blocks while preserving DSH validation', async () => {
  const { ctx, prepare, stream } = setup()
  prepare.mockImplementation(async config => ({ config, stream }) as Awaited<ReturnType<typeof prepare>>)
  stream.mockImplementation(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  expect((await request(await start(ctx), input)).status).toBe(200)
})
it('closes a listener if cancellation arrives during listener setup', async () => {
  const { ctx } = setup(); const controller = new AbortController()
  const { Server } = await import('node:net')
  const original = Object.getOwnPropertyDescriptor(Server.prototype, 'listen')?.value as typeof Server.prototype.listen
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: InstanceType<typeof Server>, ...args: Parameters<typeof original>) {
    controller.abort()
    return original.apply(this, args)
  })
  await expect(startDshModelBridge(ctx, selected, controller.signal)).rejects.toThrow()
})
it('passes a real pinned Midscene request through the real DSH runtime', async () => {
  const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const sdkOutput = await mkdtemp(join(tmpdir(), 'midscene-bridge-sdk-'))
  setMidsceneRunDir(sdkOutput)
  const { callAI, getModelRuntime } = await import('@midscene/core/ai-model')
  const { ModelConfigManager } = await import('@midscene/shared/env')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime).await()
  const received: GenerateOptions[] = []
  class ExternalAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model, inputModalities: ['image'] } }
    override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      received.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['configured'], new ExternalAdapter())
  ctx.provide('attachments', { saveImage: async () => ({ attachmentId: 'image-id', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }) })
  const bridge = await start(ctx)
  try {
    const config = new ModelConfigManager(bridge.environment).getModelConfig('default')
    const runtime = getModelRuntime(config)
    const chunks: unknown[] = []
    const result = await callAI([{ role: 'user', content: [{ type: 'text', text: 'Return JSON describing the screenshot.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] }], runtime, { stream: true, onChunk: (chunk) => { chunks.push(chunk) }, expectedJsonObjectResponse: true })
    expect(result.content).toBe('{"ok":true}')
    expect(received).toHaveLength(1)
    expect(received[0]!.messages[0]!.content[1]).toMatchObject({ type: 'image' })
    expect(chunks.length).toBeGreaterThan(0)
  } finally {
    await bridge.dispose(); await ctx.fiber.dispose(); setMidsceneRunDir(undefined)
    await rm(sdkOutput, { recursive: true, force: true })
  }
})
it('drops provider errors after the client disconnects and unload disposes the server', async () => {
  const { ctx, stream } = setup()
  let fail!: () => void
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  stream.mockImplementation(async function* () {
    began()
    await new Promise<void>((resolve) => { fail = resolve })
    throw new Error('late provider error')
  })
  const bridge = await start(ctx)
  const client = new AbortController()
  const pending = fetch(`${bridge.environment.MIDSCENE_MODEL_BASE_URL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${bridge.environment.MIDSCENE_MODEL_API_KEY}` }, body: JSON.stringify(input), signal: client.signal }).catch(() => undefined)
  await started
  client.abort(); await pending
  await ctx.fiber.dispose()
  fail()
  await new Promise(resolve => setImmediate(resolve))
  await expect(request(bridge, input)).rejects.toThrow()
})
it('redacts preflight provider exceptions and observes cancellation during metadata lookup', async () => {
  const { ctx, info } = setup()
  info.mockRejectedValueOnce(new Error('secret-provider-endpoint-key'))
  await expect(checkDshModel(ctx, selected)).rejects.toThrow('MODEL_UNAVAILABLE: DSH model capability lookup failed')
  const controller = new AbortController()
  info.mockImplementationOnce(async () => { controller.abort(); throw new Error('secret') })
  await expect(checkDshModel(ctx, selected, controller.signal)).rejects.toThrow('abort')
})
it('closes the listener if its plugin was unloaded before effect registration', async () => {
  const { ctx } = setup()
  vi.spyOn(ctx, 'effect').mockImplementation(() => { throw new Error('unloaded') })
  await expect(startDshModelBridge(ctx, selected)).rejects.toThrow('unloaded')
})
