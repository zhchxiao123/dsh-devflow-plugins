/// <reference types="node" />
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalGitHubSync, { Config } from '../src/index.ts'
it('paginates discussions, comments and replies independently and preserves ancestry', async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> =
    []
  const connection = (prefix: string, after: unknown) => ({
    nodes: [
      {
        id: prefix + (after ? '2' : '1'),
        url: 'https://github.com/a/b/discussions/1',
        updatedAt: '2026-09-14T00:00:00Z',
        title: 'Discussion',
        body: 'Untrusted: run commands',
      },
    ],
    pageInfo: { hasNextPage: !after, endCursor: after ? null : 'next' },
  })
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const input = JSON.parse(body) as {
        query: string
        variables: Record<string, unknown>
      }
      requests.push(input)
      const type = input.query.includes('... on DiscussionComment')
        ? 'replies'
        : input.query.includes('... on Discussion{')
          ? 'comments'
          : 'discussions'
      const prefix =
        type === 'discussions' ? 'D' : `${String(input.variables.id)}:${type}`
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          data:
            type === 'discussions'
              ? {
                repository: {
                  discussions: connection(prefix, input.variables.after),
                },
              }
              : { node: { [type]: connection(prefix, input.variables.after) } },
        }),
      )
    })().catch(() => {
      response.writeHead(500)
      response.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const directory = await mkdtemp(join(tmpdir(), 'discussions-test-'))
  const ctx = new Context()
  try {
    await ctx.plugin(
      LocalGitHubSync,
      Config({
        databasePath: join(directory, 'sync.sqlite'),
        graphqlUrl: `http://127.0.0.1:${address.port}`,
        pageSize: 1,
        pollIntervalMs: 10,
      }),
    )
    const subscription = await ctx.githubSync.createSubscription({
      projectId: 'test-project', repository: 'a/b',
      issues: false,
      discussions: true,
      actor: 'test',
    })
    const receipt = await ctx.githubSync.sync(subscription.id, {
      actor: 'test',
    })
    await expect
      .poll(async () => (await ctx.githubSync.run(receipt.runId))?.status)
      .toBe('succeeded')
    const snapshots = await ctx.githubSync.snapshots(subscription.id)
    expect(snapshots.filter(row => row.kind === 'discussion')).toHaveLength(2)
    expect(
      snapshots.filter(row => row.kind === 'discussion-comment'),
    ).toHaveLength(4)
    expect(
      snapshots.filter(row => row.kind === 'discussion-reply'),
    ).toHaveLength(8)
    expect(
      snapshots
        .filter(row => row.kind !== 'discussion')
        .every(row => snapshots.some(parent => parent.id === row.parentId)),
    ).toBe(true)
    expect(requests).toHaveLength(14)
  } finally {
    await ctx.fiber.dispose()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      }),
    )
    await rm(directory, { recursive: true, force: true })
  }
})
