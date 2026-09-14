# Local GitHub synchronization

English | [中文](README.zh.md)

A Node 24+ SQLite provider for `ctx.githubSync`. Use a local filesystem, not NFS or a cross-machine shared database. Only published Harness interfaces are used. A running host is required; no live chat is required.

Load `@zhchxiao123/dsh-github-sync-local` with `databasePath`. Optional `apiUrl` and `graphqlUrl` select REST and GraphQL endpoints. Credentials are references such as `env:GITHUB_TOKEN`; the environment value is used only in request headers. Redirects are rejected. Default public repositories need no credential.

When the published commands service is loaded, `/github-sync` supports:

- `add owner/repository issues|discussions|all [env:TOKEN]`, `list`, `pause id`, `resume id`. Use `update id issues|discussions|all [env:TOKEN]` to change scope or replace a credential reference.
- `sync id`, `runs [id]`, `show runId`, `cancel runId`, `resume-run runId`, `content id`.
- `storage`, `capacity bytes` (persistent, shared across instances).
- `consumer subscriptionId name beginning|now`, `cursor subscriptionId name`, `changes subscriptionId name limit`, `ack subscriptionId name sequence`, `replay subscriptionId name beginning|now`.

The optional scheduler registers `github.sync` with `{subscriptionId}` parameters. Without a scheduler, manual/public-service synchronization remains fully usable. Pausing prevents new acceptance; it does not cancel already accepted work. Scope changes require active runs to finish or be cancelled; changing repository identity requires a new subscription.

Issue and comment REST pagination excludes pull requests. Discussions, comments and replies each traverse their own GraphQL connection. Initial runs reconcile selected types. Later Issue runs use the last successful start time minus `overlapMs`; `reconcileIntervalMs` forces full scans to detect missed edits/deletions. A failed type makes the result partial or failed and does not advance the successful watermark. Only a fully completed type enumeration may mark unseen objects deleted. Authorization failures, 404s, GraphQL errors and interrupted pages do not imply deletion.

SQLite transactions atomically commit current snapshots, historical change snapshots and page progress. Per-run response checkpoints allow a new lease holder to replay committed pages without additional versions or refetches and resume unfinished pagination. Schema versions other than the supported version fail loudly. Runs retain request receipts, response checkpoints and history; no automatic historical cleanup occurs.

`pollIntervalMs`, `leaseMs`, `concurrency`, `pageSize`, `maxPages`, `requestTimeoutMs`, `retryLimit`, `retryDelayMs`, `maxRetryDelayMs`, `overlapMs`, `reconcileIntervalMs` and `capacityBytes` are validated configuration. `maxRetryDelayMs` bounds each timer slice, never shortens a server Retry-After deadline. `maxPages` exhaustion is an explicit incomplete run; explicitly resume the same failed/partial run with `resume-run runId`; it grants another page budget while retaining the receipt and checkpoints. The capacity measures persisted JSON payload bytes, including retained response checkpoints, rather than physical SQLite allocation. SQLite pages, indexes and WAL add filesystem overhead. Capacity overflow rolls back that content batch; existing consumers and replay remain usable. Capacity failures durably block new synchronization even when the overflowing batch rolled back. Raising capacity and its caller audit are persistent; resuming a failed/partial run is an explicit separate action.

Instances share durable subscription serialization, leases renewed independently of dispatcher polling, and monotonically increasing execution fences. Expired or cancelled execution cannot commit late responses. Disposal aborts requests and awaits their shutdown; abandoned leases can be resumed by the next instance. Durable corruption is reported through service errors or storage health, never silently skipped.

The provider only reads GitHub. It does not comment, close issues, launch agents or create Devflow cards. Consumer effects must independently deduplicate change IDs.

Subscriptions belong to a stable Harness workspace `projectId`, independently of their GitHub repository. New subscriptions require that identity. Tools, HTTP and slash commands derive it from the actual session workspace. Scoped subscription, run, content, watcher and consumer operations check ownership before reading or mutating; a project cannot attach a schedule to another project's subscription. Omitted service scopes are reserved for trusted host internals. Storage capacity remains a shared host resource.

Legacy subscriptions remain unassigned and do not execute automatically. `unassignedSubscriptions()` lists them; `claimSubscription(id, projectId, actor)` atomically binds ownership, pauses the subscription and annotates its run snapshots. Previously active runs retain checkpoints and become failed with `PROJECT_CLAIM_REQUIRES_RESUME`; an explicit resume is required. Existing completed history and durable consumer positions are preserved. A claimed subscription cannot be reassigned.
