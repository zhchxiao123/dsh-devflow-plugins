/// <reference types="node" />
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { GitHub } from '../src/github.ts'
import type { GitHubOptions } from '../src/github.ts'
import type { Subscription } from '@zhchxiao123/dsh-github-sync'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const subscription: Subscription = {
  id: 's',
  repository: 'a/b',
  issues: true,
  discussions: true,
  actor: 'test',
  paused: false,
  revision: 1,
}
async function client(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  overrides: Partial<GitHubOptions> = {},
  signal = new AbortController().signal,
  token?: string,
) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        }),
      ),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const origin = `http://127.0.0.1:${address.port}`
  const progress: Array<{ retry: boolean; until?: number }> = []
  const api = new GitHub(
    {
      apiUrl: origin,
      graphqlUrl: origin,
      pageSize: 1,
      requestTimeoutMs: 100,
      retryLimit: 0,
      retryDelayMs: 1,
      maxRetryDelayMs: 100,
      ...overrides,
    },
    token,
    signal,
    (retry, until) => {
      progress.push({ retry, ...(until === undefined ? {} : { until }) })
    },
  )
  return { api, origin, progress }
}
async function collect<T>(generator: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of generator) result.push(value)
  return result
}
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
it('retries server failures, uses token only in headers and records rate waiting', async () => {
  let calls = 0
  const { api, origin, progress } = await client(
    (request, response) => {
      expect(request.headers.authorization).toBe('Bearer credential')
      calls++
      if (calls === 1) {
        response.setHeader('retry-after', '0')
        json(response, {}, 429)
      } else json(response, [])
    },
    { retryLimit: 1 },
    undefined,
    'credential',
  )
  expect(await api.request(origin)).toEqual([])
  expect(calls).toBe(2)
  expect(progress).toHaveLength(1)
})
it('retries network failures and reports sanitized exhaustion without credential data', async () => {
  const { api, origin } = await client(
    (request) => {
      request.socket.destroy()
    },
    { retryLimit: 1 },
    undefined,
    'private-token',
  )
  await expect(api.request(origin)).rejects.toThrow(
    'GitHub network request failed',
  )
})
it('rejects redirects without forwarding authorization to the target', async () => {
  const { api, origin } = await client((_request, response) => {
    response.writeHead(302, { location: 'https://example.com/private' })
    response.end()
  })
  await expect(api.request(origin)).rejects.toThrow('network request failed')
})
it('cancels an active rate-limit wait promptly', async () => {
  const controller = new AbortController()
  const { api, origin, progress } = await client(
    (_request, response) => {
      response.setHeader('retry-after', '60')
      json(response, {}, 429)
    },
    { retryLimit: 2 },
    controller.signal,
  )
  const promise = api.request(origin)
  const rejected = expect(promise).rejects.toThrow('Cancelled')
  await expect.poll(() => progress.length).toBe(1)
  controller.abort()
  await rejected
})
it.each([
  null,
  {},
  [null],
  [{ id: null }],
  [{ id: 1, html_url: 1 }],
  [{ id: 1, html_url: 'https://example.com', updated_at: 'today', number: 0 }],
])('rejects malformed Issue page %j', async (payload) => {
  const { api } = await client((_request, response) => {
    json(response, payload)
  })
  await expect(collect(api.issues(subscription))).rejects.toThrow('Malformed')
})
it('rejects invalid number and invalid title/body types at the remote boundary', async () => {
  const base = {
    id: 1,
    html_url: 'https://example.com',
    updated_at: '2026-01-01',
    title: null,
    body: null,
    state: null,
    number: 0,
  }
  for (const patch of [{}, { title: 5 }, { body: {} }, { state: 4 }]) {
    const { api } = await client((_request, response) => {
      json(response, [{ ...base, ...patch }])
    })
    await expect(collect(api.issues(subscription))).rejects.toThrow(
      /Malformed/u,
    )
  }
})
it.each([
  { errors: [{ message: 'not allowed' }] },
  { data: null },
  { data: { repository: { discussions: null } } },
  {
    data: {
      repository: {
        discussions: { nodes: [], pageInfo: { hasNextPage: 'yes' } },
      },
    },
  },
  {
    data: {
      repository: {
        discussions: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    },
  },
])('rejects inaccessible or malformed discussions %j', async (payload) => {
  const { api } = await client((_request, response) => {
    json(response, payload)
  })
  await expect(collect(api.discussions(subscription))).rejects.toThrow()
})
it('detects a GraphQL pagination cursor that repeats rather than truncating silently', async () => {
  const { api } = await client((_request, response) => {
    json(response, {
      data: {
        repository: {
          discussions: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: 'same' },
          },
        },
      },
    })
  })
  await expect(collect(api.discussions(subscription))).rejects.toThrow(
    'Repeated GitHub cursor',
  )
})
it('retains issue-comment parents across paginated REST responses', async () => {
  const { api } = await client((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.searchParams.get('page') === '2') {
      json(response, [])
      return
    }
    json(
      response,
      url.pathname.endsWith('/issues')
        ? [
          {
            id: 1,
            number: 1,
            title: 'title',
            state: 'open',
            html_url: 'https://example.com/i',
            updated_at: '2026-01-01',
          },
        ]
        : [
          {
            id: 2,
            html_url: 'https://example.com/c',
            updated_at: '2026-01-01',
            body: 'reply',
          },
        ],
    )
  })
  const pages = await collect(api.issues(subscription, 1))
  expect(pages.flat().find(row => row.kind === 'issue-comment')?.parentId).toBe(
    'issue:1',
  )
})
it('handles nonnumeric rate-limit headers using its configured minimum wait', async () => {
  let count = 0
  const { api, origin } = await client(
    (_request, response) => {
      count++
      if (count === 1) {
        response.setHeader('retry-after', 'invalid')
        response.setHeader('x-ratelimit-reset', 'invalid')
        json(response, {}, 429)
      } else json(response, [])
    },
    { retryLimit: 1 },
  )
  expect(await api.request(origin)).toEqual([])
})
it('accepts HTTP-date Retry-After values without retrying ahead of the server deadline', async () => {
  let count = 0
  const { api, origin } = await client(
    (_request, response) => {
      count++
      if (count === 1) {
        response.setHeader(
          'retry-after',
          new Date(Date.now() - 1000).toUTCString(),
        )
        json(response, {}, 429)
      } else json(response, [])
    },
    { retryLimit: 1 },
  )
  expect(await api.request(origin)).toEqual([])
})
