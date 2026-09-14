# GitHub synchronization service

English | [中文](README.zh.md)

`ctx.githubSync` is a durable content capability. Load a provider such as `@zhchxiao123/dsh-github-sync-local`; this definition alone supplies no storage or execution. It does not depend on Devflow or an active agent session.

Consumers register an independent position using `registerConsumer(subscriptionId, consumerId, 'beginning' | 'now')`, read ordered `readChanges` pages, then acknowledge each successfully processed sequence in order. An acknowledgement cannot jump over an undelivered or unacknowledged record. `replay` explicitly resets a consumer. `consumerState` exposes acknowledged and delivered positions.

Every change embeds the exact historical snapshot version. `consumePage` is the minimal exported consumer example: supply a side-effect handler that deduplicates by change ID. A crash between the effect and acknowledgement causes redelivery. Concurrent workers sharing one consumer ID must coordinate their own effects.

`watch(subscriptionId, listener)` provides advisory, local-process notifications after durable commit. Its disposer removes the listener. Notifications can be missed or duplicated; consumers must also poll the durable stream. Listener failure does not roll back committed content.

`sync(subscriptionId, { actor, triggerId?, cancelRequested? })` returns `{runId, acceptedAt}` only after acceptance is durable. Reusing a trigger returns the same run; using it for another subscription fails. Poll `run(runId)` for `queued`, `running`, `waiting`, `succeeded`, `partial`, `failed`, or `cancelled`. Acceptance is not completion.

External content remains untrusted data. This package does not evaluate issues, create tasks, execute content, or write to GitHub.

Cancellation reconciliation uses the original trigger ID with `cancelRequested: true`: it cancels the existing receipt or persists a cancelled receipt before returning. Later normal deliveries of that trigger cannot start work. `resumeRun(runId, actor)` explicitly resumes a failed/partial run with its original receipt and committed pages. A changed subscription scope or a later content commit makes that checkpoint stale and requires a fresh synchronization. `storage()` includes the last capacity change actor and time.
