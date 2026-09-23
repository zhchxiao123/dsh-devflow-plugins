import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const assets = fileURLToPath(new URL('./board/', import.meta.url))
const stages = ['draft', 'designing', 'ready', 'developing', 'reviewing', 'testing', 'done']
const types = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/board.css', ['board.css', 'text/css; charset=utf-8']],
  ['/board.js', ['board.js', 'text/javascript; charset=utf-8']],
])

function send(response, status, content, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  })
  response.end(content)
}

export async function startBoard(store, projectRoot) {
  const server = createServer(async (request, response) => {
    if (!['127.0.0.1', 'localhost'].includes(request.headers.host?.split(':')[0])) {
      send(response, 403, JSON.stringify({ error: 'Invalid host' }))
      return
    }
    if (request.method !== 'GET') {
      send(response, 405, JSON.stringify({ error: 'Read only' }))
      return
    }
    const pathname = new URL(request.url, 'http://localhost').pathname
    try {
      if (pathname === '/api/cards') {
        const cards = await store.list()
        send(response, 200, JSON.stringify({ cards, stages, projectRoot, updatedAt: new Date().toISOString() }))
        return
      }
      if (pathname === '/api/archived') {
        send(response, 200, JSON.stringify({ cards: await store.archived() }))
        return
      }
      if (pathname.startsWith('/api/cards/')) {
        const id = decodeURIComponent(pathname.slice('/api/cards/'.length))
        const card = await store.read(id)
        send(response, 200, JSON.stringify(card))
        return
      }
      const asset = types.get(pathname)
      if (!asset) { send(response, 404, JSON.stringify({ error: 'Not found' })); return }
      send(response, 200, await readFile(join(assets, asset[0])), asset[1])
    } catch (error) {
      const status = error.code === 'ENOENT' || error.message === 'invalid card id' || error.message.startsWith('card not found:') ? 404 : 500
      send(response, status, JSON.stringify({ error: status === 404 ? 'Card not found' : error.message }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
