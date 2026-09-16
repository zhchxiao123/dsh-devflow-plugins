/** Run-scoped OpenAI transport over the published Harness LLM and attachment seams. */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createMessage, type ContentBlock, type LlmCallConfig, type Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { MODEL_FAMILY_VALUES } from '@midscene/shared/env'
import { redactSecret } from './secret-redaction.ts'
import type { ModelEnvironment } from './model.ts'

export interface DshModelSelection extends LlmCallConfig { family: string }
export interface DshModelBridge extends ModelEnvironment { dispose(): Promise<void> }

/** Map only canonical model identifiers; arbitrary gateway aliases require a project choice. */
export function inferMidsceneFamily(model: string): string | undefined {
  if (/^gpt-6(?:[.-]|$)/i.test(model)) return 'gpt-6'
  if (/^gpt-5(?:[.-]|$)/i.test(model)) return 'gpt-5'
  if (/^qwen3-vl(?:-|$)/i.test(model)) return 'qwen3-vl'
  if (/^qwen2\.5-vl(?:-|$)/i.test(model)) return 'qwen2.5-vl'
  if (/^gemini-/i.test(model)) return 'gemini'
  return undefined
}

export async function checkDshModel(ctx: Context, selection: DshModelSelection, signal?: AbortSignal): Promise<'available' | 'unknown'> {
  signal?.throwIfAborted()
  if (!MODEL_FAMILY_VALUES.some(value => value === selection.family)) throw new BridgeError('MODEL_INCOMPATIBLE: choose a supported Midscene family')
  const llm = ctx.get('llm')
  if (!llm || !ctx.get('attachments')) throw new BridgeError('MODEL_NOT_CONFIGURED: DSH LLM and attachment services are required')
  let model
  try { model = await llm.resolveModelInfo(selection.provider, selection.model, signal) }
  catch {
    signal?.throwIfAborted()
    throw new BridgeError('MODEL_UNAVAILABLE: DSH model capability lookup failed')
  }
  if (model.inputModalities && !model.inputModalities.includes('image')) throw new BridgeError('MODEL_INCOMPATIBLE: selected DSH model rejects images')
  signal?.throwIfAborted()
  return model.inputModalities ? 'available' : 'unknown'
}

class BridgeError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('MODEL_PROTOCOL: expected object')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new BridgeError('MODEL_PROTOCOL: unsupported request field')
}

async function messages(attachments: AttachmentStore, value: unknown, signal: AbortSignal): Promise<Message[]> {
  if (!Array.isArray(value) || !value.length) throw new BridgeError('MODEL_PROTOCOL: messages required')
  const result: Message[] = []
  for (const entry of value) {
    const message = object(entry)
    keys(message, ['role', 'content'])
    const role = message.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') throw new BridgeError('MODEL_PROTOCOL: unsupported message role')
    const content: ContentBlock[] = []
    const parts: unknown[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []
    if (!parts.length) throw new BridgeError('MODEL_PROTOCOL: message content required')
    for (const entry of parts) {
      const part = object(entry)
      if (part.type === 'text') {
        keys(part, ['type', 'text'])
        if (typeof part.text !== 'string') throw new BridgeError('MODEL_PROTOCOL: text required')
        content.push({ type: 'text', text: part.text })
      } else if (part.type === 'image_url' && role === 'user') {
        keys(part, ['type', 'image_url'])
        const image = object(part.image_url)
        keys(image, ['url', 'detail'])
        if (image.detail !== undefined && image.detail !== 'auto' && image.detail !== 'high' && image.detail !== 'original') throw new BridgeError('MODEL_PROTOCOL: unsupported image detail')
        const match = typeof image.url === 'string' ? /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.url) : null
        if (!match) throw new BridgeError('MODEL_PROTOCOL: inline raster image required')
        const mediaType = match[1]
        if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif') throw new BridgeError('MODEL_PROTOCOL: image type')
        const data = Buffer.from(match[2] as string, 'base64')
        if (data.toString('base64') !== match[2]) throw new BridgeError('MODEL_PROTOCOL: invalid base64')
        signal.throwIfAborted()
        const attachment = await attachments.saveImage({ data, mediaType })
        if (attachment.originalDimensions) throw new BridgeError('MODEL_INCOMPATIBLE: DSH resized screenshot; coordinate fidelity cannot be guaranteed')
        content.push({ type: 'image', attachment })
      } else throw new BridgeError('MODEL_PROTOCOL: unsupported content')
    }
    result.push(createMessage({ role, content, source: { kind: 'plugin', plugin: 'devflow-midscene' } }))
  }
  return result
}

/** No provider credentials cross this boundary; the bearer token authorizes this run only. */
export async function startDshModelBridge(ctx: Context, selected: DshModelSelection, signal?: AbortSignal): Promise<DshModelBridge> {
  const selection = structuredClone(selected)
  const capability = await checkDshModel(ctx, selection, signal)
  const llm = ctx.get('llm') as Context['llm']
  const attachments = ctx.get('attachments') as AttachmentStore
  const token = randomBytes(32).toString('hex')
  const lifetime = new AbortController()
  const requests = new Set<AbortController>()
  const server = createServer((request, response) => {
    const controller = new AbortController()
    const requestSignal = AbortSignal.any([lifetime.signal, controller.signal])
    requests.add(controller)
    response.once('close', () => { controller.abort(); requests.delete(controller) })
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return }
      let bytes = 0
      const chunks: Buffer[] = []
      // A protocol admission bound, independent of model context or deployment budgets.
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk as Uint8Array)
        bytes += buffer.length
        if (bytes > 32 * 1024 * 1024) throw new BridgeError('MODEL_PROTOCOL: request exceeds 32 MiB')
        chunks.push(buffer)
      }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      keys(body, ['model', 'messages', 'stream', 'stream_options', 'temperature', 'max_tokens', 'max_completion_tokens', 'stop'])
      if (body.model !== selection.model) throw new BridgeError('MODEL_PROTOCOL: model is fixed for this run')
      if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new BridgeError('MODEL_PROTOCOL: invalid stream flag')
      if (body.stream_options !== undefined) {
        const options = object(body.stream_options)
        keys(options, ['include_usage'])
        if (options.include_usage !== true) throw new BridgeError('MODEL_PROTOCOL: invalid stream options')
      }
      const config: LlmCallConfig = { ...selection }
      delete (config as Partial<DshModelSelection>).family
      if (body.temperature !== undefined) {
        if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature)) throw new BridgeError('MODEL_PROTOCOL: invalid temperature')
        config.temperature = body.temperature
      }
      if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw new BridgeError('MODEL_PROTOCOL: conflicting token limits')
      const maxTokens = body.max_tokens ?? body.max_completion_tokens
      if (maxTokens !== undefined) {
        if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new BridgeError('MODEL_PROTOCOL: invalid token limit')
        config.maxTokens = maxTokens
      }
      if (body.stop !== undefined) {
        const stop = typeof body.stop === 'string' ? [body.stop] : body.stop
        if (!Array.isArray(stop) || !stop.every((item: unknown) => typeof item === 'string')) throw new BridgeError('MODEL_PROTOCOL: invalid stop')
        config.stop = stop
      }
      const input = await messages(attachments, body.messages, requestSignal)
      requestSignal.throwIfAborted()
      const call = await llm.prepareCall(config, requestSignal)
      if (call.inputModalities && !call.inputModalities.includes('image')) throw new BridgeError('MODEL_INCOMPATIBLE: model changed to text-only')
      let text = ''; let reasoning = ''; let finish = ''; let usage: Record<string, number> | undefined
      const base = { id: 'midscene', created: Math.floor(Date.now() / 1000), model: selection.model }
      const emit = (delta: Record<string, string>, finishReason: string | null = null): void => {
        if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }], usage })}

`)
      }
      for await (const chunk of call.stream({ ...call.config, messages: input, signal: requestSignal })) {
        requestSignal.throwIfAborted()
        if (chunk.type === 'text-delta') { text += chunk.text; if (body.stream) emit({ content: chunk.text }) }
        else if (chunk.type === 'reasoning-delta') { reasoning += chunk.text; if (body.stream) emit({ reasoning_content: chunk.text }) }
        else if (chunk.type === 'usage') {
          const prompt = chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
          usage = {
            prompt_tokens: prompt, completion_tokens: chunk.usage.outputTokens,
            total_tokens: chunk.usage.totalTokens ?? prompt + chunk.usage.outputTokens,
          }
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'max-tokens') throw new BridgeError('MODEL_UNAVAILABLE: DSH model call did not complete')
          finish = chunk.reason.kind === 'stop' ? 'stop' : 'length'
        } else if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType !== 'text' && chunk.blockType !== 'reasoning') throw new BridgeError('MODEL_PROTOCOL: unsupported model output')
      }
      if (!finish) throw new BridgeError('MODEL_UNAVAILABLE: incomplete DSH model stream')
      if (body.stream) {
        emit({}, finish)
        response.end('data: [DONE]\n\n')
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text, reasoning_content: reasoning }, finish_reason: finish }], usage }))
      }
    })().catch((error: unknown) => {
      if (requestSignal.aborted) return
      const payload = { error: { message: error instanceof BridgeError ? error.message : 'MODEL_UNAVAILABLE: DSH model request failed', type: 'model_bridge_error' } }
      if (response.headersSent) response.end(`data: ${JSON.stringify(payload)}

`)
      else {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  // A successfully bound TCP listener has an AddressInfo until this owner closes it.
  const address = server.address() as AddressInfo
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => disposed ??= new Promise((resolve) => {
    lifetime.abort()
    for (const controller of requests) controller.abort()
    signal?.removeEventListener('abort', abort)
    server.close(() => { resolve() })
    server.closeAllConnections()
  })
  const abort = (): void => { void release() }
  let release: () => Promise<void>
  try { release = ctx.effect(() => dispose) }
  catch (error) { await dispose(); throw error }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) { await release(); signal.throwIfAborted() }
  return {
    capability, dispose: release,
    environment: { MIDSCENE_MODEL_API_KEY: token, MIDSCENE_MODEL_NAME: selection.model, MIDSCENE_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MIDSCENE_MODEL_FAMILY: selection.family, MIDSCENE_MODEL_RESPONSE_FORMAT: 'none', MIDSCENE_MODEL_REASONING_ENABLED: 'default' },
    redact: value => redactSecret(value, token),
  }
}
