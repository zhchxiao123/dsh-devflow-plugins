import { createServer } from 'node:http'

/** Actual SDK transport fixture. Its responses exercise parsing, never claim visual accuracy. */
export async function startModelFixture(): Promise<{
  baseUrl: string
  state: { answer: 'true' | 'false' | 'error' | 'hang'; requests: number; onRequest?: () => void }
  close: () => Promise<void>
}> {
  const state: { answer: 'true' | 'false' | 'error' | 'hang'; requests: number; onRequest?: () => void } = {
    answer: 'true',
    requests: 0,
  }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/build') {
        res.end('fixture-build')
        return
      }
      if (req.url === '/v1/chat/completions') {
        state.requests++
        state.onRequest?.()
        if (state.answer === 'hang') return
        if (state.answer === 'error') {
          res.writeHead(401)
          res.end('{"error":{"message":"fixture-token-secret","type":"authentication_error"}}')
          return
        }
        let body = ''
        for await (const chunk of req) {
          if (Buffer.isBuffer(chunk)) body += chunk.toString('utf8')
        }
        const input = JSON.parse(body) as { stream?: boolean }
        const content = `<observation>Controlled transport response, not visual evaluation.</observation><data-json>{"StatementIsTruthy":${state.answer}}</data-json>`
        const common = {
          id: 'fixture',
          model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
        if (input.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(
            `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          )
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(common))
        }
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>Acceptance fixture</h1>')
    })().catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        }),
      )
    },
  }
}
