/** Read-only GitHub protocol client. Redirects cannot forward credential headers. */
import type {
  ContentKind,
  Snapshot,
  Subscription,
} from '@zhchxiao123/dsh-github-sync'
export type Incoming = Omit<
  Snapshot,
  'subscriptionId' | 'version' | 'fingerprint' | 'fetchedAt' | 'deleted'
>
export interface GitHubOptions {
  apiUrl: string
  graphqlUrl: string
  pageSize: number
  requestTimeoutMs: number
  retryLimit: number
  retryDelayMs: number
  maxRetryDelayMs: number
}
export class RemoteError extends Error {
  constructor(readonly code: number) {
    super(`GitHub request failed (${code})`)
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed GitHub object')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Malformed GitHub string')
  return value
}
function timestamp(value: unknown): string {
  const result = string(value)
  if (!Number.isFinite(Date.parse(result)))
    throw new Error('Malformed GitHub timestamp')
  return result
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Malformed GitHub list')
  return value
}
function content(raw: unknown, kind: ContentKind, parentId?: string): Incoming {
  const row = object(raw)
  const id = row.node_id ?? row.id
  if (typeof id !== 'string' && typeof id !== 'number')
    throw new Error('Malformed GitHub id')
  return {
    id: `${kind}:${id}`,
    kind,
    ...(parentId ? { parentId } : {}),
    url: string(row.html_url ?? row.url),
    updatedAt: timestamp(row.updated_at ?? row.updatedAt),
    title: row.title == null ? '' : string(row.title),
    body: row.body == null ? '' : string(row.body),
    state: row.state == null ? '' : string(row.state),
  }
}
export class GitHub {
  constructor(
    readonly options: GitHubOptions,
    readonly token: string | undefined,
    readonly signal: AbortSignal,
    readonly progress: (retry: boolean, waitUntil: number) => void,
    readonly cache?: {
      get(key: string): unknown
      put(key: string, data: unknown): void
    },
  ) {}
  async request(url: string, body?: unknown): Promise<unknown> {
    const key = JSON.stringify([url, body ?? null])
    const cached = this.cache?.get(key)
    if (cached !== undefined) return cached
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted()
      let response: Response
      try {
        response = await fetch(url, {
          method: body ? 'POST' : 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.any([
            this.signal,
            AbortSignal.timeout(this.options.requestTimeoutMs),
          ]),
        })
      } catch {
        this.signal.throwIfAborted()
        if (attempt >= this.options.retryLimit)
          throw new Error('GitHub network request failed')
        await this.wait(this.options.retryDelayMs)
        continue
      }
      if (response.ok) {
        const value: unknown = await response.json()
        this.cache?.put(key, value)
        return value
      }
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0'))
      if (!retryable || attempt >= this.options.retryLimit)
        throw new RemoteError(response.status)
      const retryAfter = response.headers.get('retry-after')
      const seconds = Number(retryAfter)
      const retryAt = retryAfter === null ? Number.NaN : Date.parse(retryAfter)
      const reset =
        Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now()
      await this.wait(
        Math.max(
          this.options.retryDelayMs,
          Number.isFinite(seconds)
            ? seconds * 1000
            : Number.isFinite(retryAt)
              ? retryAt - Date.now()
              : 0,
          Number.isFinite(reset) ? reset : 0,
        ),
      )
    }
  }
  async wait(ms: number): Promise<void> {
    const deadline = Date.now() + ms
    this.progress(true, deadline)
    while (Date.now() < deadline) {
      this.signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer)
          reject(new Error('Cancelled'))
        }
        const timer = setTimeout(
          () => {
            this.signal.removeEventListener('abort', abort)
            resolve()
          },
          Math.min(
            deadline - Date.now(),
            this.options.maxRetryDelayMs,
            2147483647,
          ),
        )
        this.signal.addEventListener('abort', abort, { once: true })
      })
    }
  }
  async *rest(path: string): AsyncGenerator<unknown[]> {
    for (let page = 1; ; page++) {
      const url = new URL(`${this.options.apiUrl.replace(/\/$/u, '')}/${path}`)
      url.searchParams.set('per_page', String(this.options.pageSize))
      url.searchParams.set('page', String(page))
      const rows = list(await this.request(url.href))
      yield rows
      if (rows.length < this.options.pageSize) return
    }
  }
  async *issues(
    subscription: Subscription,
    since?: number,
  ): AsyncGenerator<Incoming[]> {
    const path = `repos/${subscription.repository}/issues?state=all&sort=updated&direction=asc${since ? `&since=${encodeURIComponent(new Date(since).toISOString())}` : ''}`
    for await (const rows of this.rest(path)) {
      const issues = rows.map(object).filter(row => !('pull_request' in row))
      yield issues.map(row => content(row, 'issue'))
      for (const row of issues) {
        if (!Number.isSafeInteger(row.number) || Number(row.number) <= 0)
          throw new Error('Malformed Issue number')
        for await (const comments of this.rest(
          `repos/${subscription.repository}/issues/${String(row.number)}/comments`,
        ))
          yield comments.map(comment =>
            content(comment, 'issue-comment', content(row, 'issue').id),
          )
      }
    }
  }
  async *connection(
    query: string,
    variables: Record<string, unknown>,
    extract: (data: Record<string, unknown>) => unknown,
  ): AsyncGenerator<Record<string, unknown>[]> {
    let cursor: string | null = null
    const seen = new Set<string>()
    do {
      const response = object(
        await this.request(this.options.graphqlUrl, {
          query,
          variables: {
            ...variables,
            first: this.options.pageSize,
            after: cursor,
          },
        }),
      )
      if (response.errors)
        throw new Error(
          'GitHub Discussions unavailable or GraphQL request failed',
        )
      const connection = object(extract(object(response.data)))
      const rows = list(connection.nodes).map(object)
      yield rows
      const info = object(connection.pageInfo)
      if (typeof info.hasNextPage !== 'boolean')
        throw new Error('Malformed GitHub pagination')
      cursor = info.hasNextPage ? string(info.endCursor) : null
      if (cursor && seen.has(cursor)) throw new Error('Repeated GitHub cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
  }
  async *discussions(subscription: Subscription): AsyncGenerator<Incoming[]> {
    const [owner, name] = subscription.repository.split('/')
    const fields = 'id url updatedAt body'
    const page = 'pageInfo { hasNextPage endCursor }'
    const query = `query($owner:String!,$name:String!,$first:Int!,$after:String){repository(owner:$owner,name:$name){discussions(first:$first,after:$after){nodes{${fields} title} ${page}}}}`
    for await (const rows of this.connection(
      query,
      { owner, name },
      data => object(data.repository).discussions,
    )) {
      yield rows.map(row => content(row, 'discussion'))
      for (const row of rows) {
        const commentsQuery = `query($id:ID!,$first:Int!,$after:String){node(id:$id){... on Discussion{comments(first:$first,after:$after){nodes{${fields}} ${page}}}}}`
        for await (const comments of this.connection(
          commentsQuery,
          { id: row.id },
          data => object(data.node).comments,
        )) {
          yield comments.map(comment =>
            content(
              comment,
              'discussion-comment',
              content(row, 'discussion').id,
            ),
          )
          for (const comment of comments) {
            const repliesQuery = `query($id:ID!,$first:Int!,$after:String){node(id:$id){... on DiscussionComment{replies(first:$first,after:$after){nodes{${fields}} ${page}}}}}`
            for await (const replies of this.connection(
              repliesQuery,
              { id: comment.id },
              data => object(data.node).replies,
            ))
              yield replies.map(reply =>
                content(
                  reply,
                  'discussion-reply',
                  content(comment, 'discussion-comment').id,
                ),
              )
          }
        }
      }
    }
  }
}
