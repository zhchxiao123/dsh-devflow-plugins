# @zhchxiao123/dsh-devflow-web

English | [中文](README.zh.md)

Devflow's own browser channel: a Consumer that projects the read side of the [`ctx.devflow`](../devflow/README.md) seam onto one prefixed JSON route on [`ctx.webServer`](../../host/webserver/README.md). The board reaches its cards through this plugin rather than through any framework-owned forwarding face, which is what lets the devflow plugins compose into a stock harness — nothing here needs a change to the harness's own packages.

## The route

One prefix route, `/devflow/api`, whose last path segment names the method. The prefix names the domain, not the npm scope, so republishing these plugins under another scope is not a breaking rename.

```
POST /devflow/api/<method>    { "sessionId": "...", "id": "..." }
  -> 200 { "ok": true, "value": ... } | { "ok": false, "error": "..." }
```

Two methods exist, and the dispatch table is the whole of the face: `list` returns the session's active cards, `detail` returns one card with its complete decoded journal and current lease holder in a single round trip. A segment absent from the table has no route at all (404), reads are POST-only (405), and the store's write operations — `transition`, `create`, `claim`, `attachArtifact`, `archiveDone` — are not projected. Card moves stay on the model tool plane, the `/devflow` command plane, and the approval plane, which is devflow's three-plane split from its first PRD; changing channels is not a reason to relax it.

The request body names the viewing session and nothing else that scopes a read. The host resolves that session's workspace to its devflow root, so the browser can neither choose nor send a root, a cwd, or any other path. A session omitted reads the store's default root; an unknown session, a missing card, and an unreadable journal all arrive as `ok: false` — a settled answer the board renders as "no board", never a transport failure. The reason for a read failure stays host-side, in the log: the store names files under the devflow root, and the browser must not learn from an answer a path it could not have asked with. A refusal the face itself decides does carry its reason, because it describes what the caller sent — an unknown method, a non-POST read, or a body that is oversized, unparsable, or not an object (the last three at 400, before dispatch). The trust fence alone answers bare, so an untrusted caller learns nothing about what this route expects.

## The change stream

One upgrade endpoint, `/devflow/ws`, behind the same fence. The host listens for `devflow/card-created` and `devflow/stage-changed` and sends every connected browser one frame:

```json
{ "type": "devflow/stage-changed" }
```

A frame says that something in this host's devflow moved and nothing else. The browser answers it by refetching through the read face, so a frame can never become a second truth racing what the board renders — and it can never leak a card into a page whose workspace does not hold it, because the refetch is the same session-scoped read as every other. The channel is one-way: a client that sends anything is closed with 1008, an invalid frame drops that socket alone, and disposal takes the endpoint, the listeners, and every live socket down together.

## The trust fence

Every request passes the same rule the harness applies to `/api`, restated here because that implementation is package-internal to `@deepseek-ai/dsh-client-connection` and this plugin depends only on published surface. The `Host` header must be loopback or a configured `trustedHosts` authority (DNS-rebinding defense — `Host` is the one header a rebound page cannot forge); an explicit cross-site fetch marker is refused; and an attached `Origin` must be exactly this authority. `trustedHosts` entries must be bare canonical `host` or `host:port` values, asserted at load so a typo fails loudly instead of silently voiding or broadening the grant. Set it to whatever the deployment's `/api` fence is set to, or the board breaks exactly where the chat does.

Composition is one line beside the store and the webserver; a deployment that leaves it out keeps the tool and command planes and simply has no web board.

```yaml
- id: devflow
  name: '@zhchxiao123/dsh-devflow-filesystem'
- id: devflow-web
  name: '@zhchxiao123/dsh-devflow-web'
```

## Model Experience

None, as this package answers a human's browser with card state and touches no prompt, message, schema, stream, or tool result. The model's own view of the same cards stays with [`dsh-tool-devflow`](../tool-devflow/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **The face is read-only and stays that way** — an approval or a stage move from the browser would need its own plane, not a write method here.
- **No protocol version negotiation** — the host and browser halves ship from one package version, so neither the envelope nor the frame carries a version field; a channel that outlives that assumption needs one.
- **A frame does not say which root moved** — every connected browser refetches on every change, which is what the board did when these events reached it through the framework's forwarding face. Naming the affected root would let a page skip a refetch, but the browser has no root-to-page map to skip with; that map, not the frame, is the missing piece.
- **`trustedHosts` is configured twice** — once here and once on the harness's `/api` fence, because the two rules cannot share an implementation across a package boundary that does not export it. A deployment that changes one and not the other gets a board that will not fetch.
