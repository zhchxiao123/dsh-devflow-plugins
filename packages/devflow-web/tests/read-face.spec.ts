/**
 * REAL-composition proof: a test-only cordis.yml booted through the vendored
 * Loader mounts the card store, the webserver, and this package's route, and
 * every assertion observes the user-visible HTTP surface of the running
 * server — method dispatch, the read-only face, session scoping, the trust
 * fence, the error envelope, and teardown.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as DevflowWeb from '@zhchxiao123/dsh-devflow-web'
import type { DevflowWebResponse } from '@zhchxiao123/dsh-devflow-web/types'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A card whose journal reaches `developing`, with one registered artifact. */
function developing(): string[] {
  return [
    '{"rev":1,"at":"2026-08-26T00:00:00Z","type":"created","by":{"kind":"human","name":"byclaw"}}',
    '{"rev":2,"at":"2026-08-26T00:01:00Z","type":"transition","from":"draft","to":"designing"}',
    '{"rev":3,"at":"2026-08-26T00:02:00Z","type":"transition","from":"designing","to":"ready"}',
    '{"rev":4,"at":"2026-08-26T00:03:00Z","type":"transition","from":"ready","to":"developing"}',
    '{"rev":5,"at":"2026-08-26T00:04:00Z","type":"artifact","path":"artifacts/design.md","stage":"developing"}',
  ]
}

async function writeCard(id: string, journalLines: string[]): Promise<void> {
  const dir = join(root!, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${id}\n---\n\nBody of ${id}.\n`)
  await writeFile(join(dir, 'journal.jsonl'), journalLines.join('\n') + '\n')
}

/** Boot store + webserver + route through the real Loader; returns the listening port. */
async function boot(trustedHosts?: string[]): Promise<number> {
  const configPath = join(root!, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@zhchxiao123/dsh-devflow-filesystem'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@zhchxiao123/dsh-devflow-web'",
    ...trustedHosts === undefined
      ? []
      : ['  config:', `    trustedHosts: ${JSON.stringify(trustedHosts)}`],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@zhchxiao123/dsh-devflow-filesystem', FilesystemDevflowStore],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@zhchxiao123/dsh-devflow-web', DevflowWeb],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx.webServer.port
}

/** One raw request against the running server, with full control over method, path, and headers. */
function call(
  port: number,
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: init?.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...init?.headers },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    })
    req.on('error', reject)
    req.end(init?.body ?? '{}')
  })
}

/** POST one read method and parse its envelope. */
async function read<T>(port: number, method: string, body: object = {}): Promise<DevflowWebResponse<T>> {
  const response = await call(port, `/devflow/api/${method}`, { body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  return JSON.parse(response.body) as DevflowWebResponse<T>
}

describe('devflow-web read face over a real Loader composition', () => {
  it('projects the board reads and refuses everything else', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-web-'))
    await writeCard('0001-alpha', developing())
    await writeCard('0002-beta', ['{"rev":1,"at":"2026-08-26T00:00:00Z","type":"created","by":{"kind":"human"}}'])
    const port = await boot()

    const listed = await read<{ id: string; stage: string }[]>(port, 'list')
    expect(listed).toMatchObject({ ok: true })
    if (!listed.ok) throw new Error('expected a listing')
    expect(listed.value.map(card => [card.id, card.stage])).toEqual([
      ['0001-alpha', 'developing'],
      ['0002-beta', 'draft'],
    ])

    const detail = await read<{ card: { id: string }; entries: unknown[] }>(port, 'detail', { id: '0001-alpha' })
    expect(detail).toMatchObject({ ok: true })
    if (!detail.ok) throw new Error('expected a detail')
    expect(detail.value.card.id).toBe('0001-alpha')
    expect(detail.value.entries).toHaveLength(5)

    // The face is read-only: no write verb of the seam has a route, and an
    // unknown method never reaches the store — it answers the same envelope
    // every other refusal does.
    for (const method of ['transition', 'create', 'claim', 'attachArtifact', 'archiveDone', 'read', 'history']) {
      const refused = await call(port, `/devflow/api/${method}`)
      expect(refused.status).toBe(404)
      expect(JSON.parse(refused.body)).toEqual({ ok: false, error: `devflow-web: no read named "${method}"` })
    }
    // Reads are POST-only, and the prefix root is not a method.
    const wrongMethod = await call(port, '/devflow/api/list', { method: 'GET' })
    expect(wrongMethod.status).toBe(405)
    expect(JSON.parse(wrongMethod.body)).toMatchObject({ ok: false })
    expect((await call(port, '/devflow/api')).status).toBe(404)
    expect((await call(port, '/devflow/api/list/extra')).status).toBe(404)
  })

  it('scopes every read to the session the body names, and rejects unknown ones', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-web-'))
    await writeCard('0001-alpha', developing())
    const port = await boot()

    // No session service is composed here, so any session id is unresolvable —
    // a stable rejection in the envelope, never a crashed request.
    const scoped = await read(port, 'list', { sessionId: 'ses-unknown' })
    expect(scoped).toEqual({ ok: false, error: 'devflow-web: list failed' })

    // A missing card is the same stable rejection, not a 500 — and the store's
    // own message names files under the root, so it stays host-side.
    const missing = await read(port, 'detail', { id: '0404-gone' })
    expect(missing).toEqual({ ok: false, error: 'devflow-web: detail failed' })
    expect(JSON.stringify(missing)).not.toContain(root)
    // `detail` needs a card id; omitting it is a rejection, not a crash.
    expect(await read(port, 'detail')).toMatchObject({ ok: false })
    // An omitted session reads the store's default root, which is this one.
    expect(await read(port, 'list', {})).toMatchObject({ ok: true })
  })

  it('refuses a body it cannot trust before it dispatches anything', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-web-'))
    await writeCard('0001-alpha', developing())
    const port = await boot()

    for (const body of [
      'not json',
      '"a string is not a request"',
      '{"sessionId":42}',
      '{"id":["0001-alpha"]}',
      // Larger than the fixed body cap, which no legitimate read approaches.
      JSON.stringify({ sessionId: 'x'.repeat(70_000) }),
    ]) {
      const refused = await call(port, '/devflow/api/list', { body })
      expect(refused.status).toBe(400)
      expect(JSON.parse(refused.body)).toMatchObject({ ok: false })
    }
  })

  it('refuses requests from an untrusted authority and admits configured ones', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-web-'))
    await writeCard('0001-alpha', developing())
    const port = await boot(['harness.internal'])

    // Loopback Host is trusted; the configured authority is too.
    expect((await call(port, '/devflow/api/list', { headers: { host: 'harness.internal' } })).status).toBe(200)
    // A rebound Host is refused, as is a cross-site marker and a foreign Origin.
    expect((await call(port, '/devflow/api/list', { headers: { host: 'evil.example' } })).status).toBe(403)
    expect((await call(port, '/devflow/api/list', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await call(port, '/devflow/api/list', {
      headers: { origin: 'http://evil.example' },
    })).status).toBe(403)
    expect((await call(port, '/devflow/api/list', {
      headers: { origin: `http://127.0.0.1:${String(port)}` },
    })).status).toBe(200)
  })

  it('gives the route back when its fiber is disposed (HMR safety)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-web-'))
    await writeCard('0001-alpha', developing())
    const port = await boot()
    expect((await call(port, '/devflow/api/list')).status).toBe(200)

    const web = [...context!.loader.entries()].find(entry => entry.options.name === '@zhchxiao123/dsh-devflow-web')
    await web!.fiber!.dispose()

    // Nothing claims the prefix any more, and re-registering does not throw.
    expect((await call(port, '/devflow/api/list')).status).toBe(404)
    const again = context!.plugin(DevflowWeb, { trustedHosts: [] })
    await again.await()
    expect((await call(port, '/devflow/api/list')).status).toBe(200)
  })
})
