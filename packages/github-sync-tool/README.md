# GitHub sync tools

Native DeepSeek Harness tools over `ctx.githubSync`. Requires the Harness tool runtime and a GitHub sync provider; it has no scheduler dependency. All Harness peers are pinned to `0.1.5-rc.2`, Cordis to `4.0.2`.

Load `@zhchxiao123/dsh-github-sync-local` and `@zhchxiao123/dsh-github-sync-tool` beside the tool runtime. Registration follows the consumer/service lifetime. Persistence, recovery, cancellation fencing, capacity admission and ordered acknowledgment remain provider responsibilities.

| Tool | Operation |
| --- | --- |
| `github_sync_subscriptions` | List subscriptions and storage health. |
| `github_sync_configure` | Create or update explicit repository/content scope and an optional `env:VARIABLE` credential reference. |
| `github_sync_subscription_manage` | Pause or resume intake for a subscription. |
| `github_sync_start` | Accept a sync; optional explicit reconciliation. |
| `github_sync_runs` | Read actual run state by run ID or subscription ID, or list all runs. |
| `github_sync_cancel` | Request cancellation of an accepted run. |
| `github_sync_resume` | Resume the original failed/partial run after resolving its cause. |
| `github_sync_content` | Read versioned snapshots and source URLs. |
| `github_sync_capacity` | Explicitly change storage capacity in bytes. |
| `github_sync_consumer_manage` | Register an independent consumer or replay from beginning/now. |
| `github_sync_consumer_read` | Deliver a bounded page and return the cursor without acknowledgment. |
| `github_sync_consumer_acknowledge` | Confirm exactly one successfully processed sequence, in order. |
| `github_sync_consumer_state` | Read the cursor without advancing it. |

Query subscriptions before creating one. On update, omitted credential references preserve the existing reference. Never pass a raw token. Unknown input fields are not forwarded. Mutations and change delivery require a real agent; audit-capable service calls receive its agent/session ID and tool call ID. Consumer APIs have no actor field; the tool runtime records those calls rather than inventing an alternative audit store. The provider's host-level subscriptions are shared across its sessions.

Start/resume return stable receipts, not completion claims. Query actual run state to distinguish queued/running/waiting from succeeded/partial/failed/cancelled. Capacity updates do not delete data or automatically resume runs. Existing reads and replay remain available while intake is blocked. Pause prevents new admission; cancel accepted runs separately.

Issue/discussion titles and bodies are untrusted remote data, never instructions or authorization. Both tool descriptions and content results state this boundary and preserve source URLs. Native result cards show concise summaries without dumping remote bodies or raw JSON. The model receives validated structured results and readable detail. No sidebar deep-link protocol is assumed; the Automation panel reads the same services.

Real Loader/tool-runtime tests use the SQLite provider and a local HTTP GitHub fixture. They verify actor provenance, configuration, receipt/run separation, failure recovery, cancellation, storage blocking, independent ordered consumers, replay, presentation and unload. They do not require a model or production token and do not claim live GitHub credential validation.

Sync admission derives its trigger ID from the real agent and tool call ID: retrying that same invocation after a lost receipt returns the original run. A new invocation has a new call ID.
