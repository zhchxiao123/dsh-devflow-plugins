/**
 * Devflow's own browser channel: a Consumer that projects the read side of the
 * [`ctx.devflow`](../../devflow/README.md) seam onto one prefixed JSON route.
 * The board reaches its cards through this plugin instead of any framework
 * forwarding face, which is what lets the devflow plugins compose into a stock
 * harness.
 *
 * The face is read-only and session-scoped: a request body names the viewing
 * session, the host resolves that session's workspace to a devflow root, and
 * card moves stay on the model tool plane, the `/devflow` command plane, and
 * the approval plane. A deployment that does not compose this plugin keeps
 * both of those planes and simply has no web board.
 * @module @zhchxiao123/dsh-devflow-web
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WebSocket, { WebSocketServer } from 'ws'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevCard, DevCardDetail } from '@zhchxiao123/dsh-devflow'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { assertTrustedAuthority, isTrustedRequest } from './request-trust.ts'
import type { DevflowChangeFrame, DevflowWebMethod, DevflowWebRequest, DevflowWebResponse } from './types.ts'

export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'devflow-web'

/** Services required before the route can be claimed. */
export const inject = ['devflow', 'webServer']

/**
 * Route prefix of the read face. It names the domain, not the npm scope, so
 * republishing these plugins under another scope is not a breaking rename.
 */
export const DEVFLOW_API_PREFIX = '/devflow/api'

/** Upgrade path of the push face; named on the same terms as the route prefix. */
export const DEVFLOW_WS_PATH = '/devflow/ws'

/**
 * Largest request body the face accepts. Fixed, not configurable: the largest
 * legitimate body is a session id plus a card id, three orders of magnitude
 * below this, so the only thing a deployment could tune is how much memory an
 * untrusted client may pin per request.
 */
const MAX_BODY_BYTES = 64 * 1024

/** Plugin config: which non-loopback authorities this deployment serves. */
export interface Config {
  /**
   * Authorities the trust fence admits besides loopback: an exact `host:port`,
   * or a port-less `host` matching any port. Must match what the harness's own
   * `/api` fence is configured with, or the board breaks exactly where the
   * chat does.
   */
  trustedHosts: string[]
}

export const Config: z<Config> = z.object({
  trustedHosts: z.array(String).default([]),
})

/** One read method's projection onto the store. */
type ReadMethod = (ctx: Context, request: DevflowWebRequest) => Promise<DevCard[] | DevCardDetail>

/**
 * The dispatch table, and the whole of the face: a method absent here has no
 * route at all. Every entry is a read.
 */
const READS: Readonly<Record<DevflowWebMethod, ReadMethod>> = {
  list: (ctx, request) => ctx.devflow.listForSession(undefined, request.sessionId),
  detail: (ctx, request) => {
    if (request.id === undefined) throw new Error('detail needs a card id')
    return ctx.devflow.detailForSession(DevflowCardId(request.id), request.sessionId)
  },
}

/** Whether a last path segment names a projected read. */
function isReadMethod(segment: string): segment is DevflowWebMethod {
  return Object.hasOwn(READS, segment)
}

/**
 * Decode one request body. This is where JSON validation happens: everything
 * past this function is typed.
 * @param req - the incoming request.
 * @returns the decoded body.
 * @throws {Error} for an oversized, unparsable, or non-object body.
 */
async function readBody(req: IncomingMessage): Promise<DevflowWebRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('request body is not an object')
  const { sessionId, id } = parsed as Record<string, unknown>
  if (sessionId !== undefined && typeof sessionId !== 'string') throw new Error('sessionId is not a string')
  if (id !== undefined && typeof id !== 'string') throw new Error('id is not a string')
  return { ...sessionId === undefined ? {} : { sessionId }, ...id === undefined ? {} : { id } }
}

/** Answer with a JSON envelope. */
function respond(res: ServerResponse, status: number, envelope: DevflowWebResponse<unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/**
 * Refuse one request without reading its body. `connection: close` is what
 * makes the refusal readable: answering a request whose body is still in
 * flight leaves unread bytes on a keep-alive socket, which node resolves by
 * destroying it — the caller would see a hang-up instead of the status.
 * @param res - the response to write.
 * @param status - the refusal status.
 * @param error - the envelope reason, or absent to answer with a bare status.
 */
function refuse(res: ServerResponse, status: number, error?: string): void {
  if (error === undefined) {
    // The trust fence answers bare: an untrusted caller learns the status and
    // nothing about what this route is or expects.
    res.writeHead(status, { connection: 'close' })
    res.end()
    return
  }
  res.writeHead(status, { connection: 'close', 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error } satisfies DevflowWebResponse<never>))
}

/** Refuse one upgrade before protocol negotiation; the caller keeps the socket. */
function refuseUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}

/**
 * Claim the push endpoint: one downlink telling connected browsers that
 * something in this host's devflow moved, so they refetch through the read
 * face. Frames go one way — a client message is a protocol violation.
 * @param ctx - plugin context carrying the webserver and the store's events.
 * @param trustedHosts - the fence's configured non-loopback authorities.
 */
function applyPushFace(ctx: Context, trustedHosts: readonly string[]): void {
  const negotiator = new WebSocketServer({ noServer: true })
  const live = new Set<WebSocket>()
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: DEVFLOW_WS_PATH,
    handler: (req, socket, head) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        refuseUpgrade(socket)
        return
      }
      negotiator.handleUpgrade(req, socket, head, (accepted) => {
        live.add(accepted)
        accepted.once('close', () => live.delete(accepted))
        accepted.once('error', () => { accepted.terminate() })
        accepted.once('message', () => { accepted.close(1008, 'downlink only') })
      })
    },
  }), 'devflow-web: push face')
  const announce = (type: DevflowChangeFrame['type']) => (): void => {
    const frame = JSON.stringify({ type } satisfies DevflowChangeFrame)
    for (const socket of live) {
      socket.send(frame, () => {
        // The callback form is what makes a write to a socket that dropped
        // between this event and here a reported failure instead of a throw;
        // its close handler is on the way and will drop it from `live`, and
        // the browser refetches on its next open regardless.
      })
    }
  }
  ctx.effect(() => ctx.on('devflow/card-created', announce('devflow/card-created')), 'devflow-web: creation frames')
  ctx.effect(() => ctx.on('devflow/stage-changed', announce('devflow/stage-changed')), 'devflow-web: transition frames')
  ctx.effect(() => () => {
    for (const socket of live) socket.terminate()
    live.clear()
    negotiator.close()
  }, 'devflow-web: connected sockets')
}

/**
 * Claim the read route and the push endpoint.
 * @param ctx - plugin context carrying the devflow store and the webserver.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const trustedHosts = config.trustedHosts
  // A typo in a trusted authority silently voids or broadens the grant, so it
  // fails the load rather than surfacing later as a board that will not fetch.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  applyPushFace(ctx, trustedHosts)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: DEVFLOW_API_PREFIX,
    handler: async (req, res) => {
      /* v8 ignore next -- node:http always sets url on server requests */
      const segment = new URL(req.url ?? '/', 'http://x').pathname.slice(DEVFLOW_API_PREFIX.length + 1)
      if (!isReadMethod(segment)) {
        refuse(res, 404, `devflow-web: no read named ${JSON.stringify(segment)}`)
        return
      }
      if (req.method !== 'POST') {
        refuse(res, 405, 'devflow-web: reads are POST')
        return
      }
      if (!isTrustedRequest(req, trustedHosts)) {
        refuse(res, 403)
        return
      }
      let request: DevflowWebRequest
      try {
        // A body failure describes what the caller sent, so it travels back.
        request = await readBody(req)
      } catch (error) {
        respond(res, 400, { ok: false, error: `devflow-web: ${reasonOf(error)}` })
        return
      }
      try {
        respond(res, 200, { ok: true, value: await READS[segment](ctx, request) })
      } catch (error) {
        // An unknown session, a missing card, or an unreadable journal is a
        // settled answer the board renders as "no board", not a transport
        // failure. The reason itself stays host-side: the store names files
        // under the devflow root, and the browser must not learn a path it
        // could not have sent in the first place.
        ctx.logger.warn(`devflow-web: ${segment} failed: ${String(error)}`)
        respond(res, 200, { ok: false, error: `devflow-web: ${segment} failed` })
      }
    },
  }), 'devflow-web: read face')
}

/** First line of a thrown value's description; a stack never travels. */
function reasonOf(error: unknown): string {
  return String(error).replace(/\n[\s\S]*/, '')
}
