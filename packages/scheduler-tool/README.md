# Scheduler tools

Native DeepSeek Harness tools over `ctx.scheduler`, independently loadable with any conforming scheduler provider. Uses published Harness `0.1.5-rc.2` and Cordis `4.0.2`.

Load `@zhchxiao123/dsh-scheduler-local`, the Harness tool runtime and `@zhchxiao123/dsh-scheduler-tool` in the profile. The tools disappear when the consumer or its required service is disposed. They neither own timers nor maintain another state machine.

| Tool | Operation |
| --- | --- |
| `scheduler_query` | List plans and delivery history; optionally filter by plan ID. |
| `scheduler_configure` | Create or replace a plan's configuration; supports fixed milliseconds or Cron with IANA timezone. |
| `scheduler_manage` | Pause, resume or delete a plan. |
| `scheduler_trigger` | Immediately enqueue a plan, or request cancellation by trigger ID. |

Query first, then configure. GitHub intake uses handler `github.sync` with exactly `{"subscriptionId":"..."}` parameters. Other registered handlers can use their own lossless JSON parameters. The provider validates rules, timeout and retry budgets, and handler parameters. Updating replaces configuration, so carry forward settings that should remain. Deleting a plan stops future scheduling without cancelling previously accepted work.

Mutations require a real owning agent. Actor identity is derived from its session/agent ID and tool call ID; model arguments cannot impersonate an actor. Undeclared fields are not forwarded to the service. Plans are shared only by sessions in the same registered workspace.

Native pending cards show the operation and relevant identifier or rule. Result cards show a concise summary; the model receives validated structured output plus readable details. A trigger receipt is not downstream completion: inspect `scheduler_query` and follow its `runId` using the handler's run tool. The Automation sidebar presents the same service state; these tools do not invent a sidebar URL protocol.

Tests use the real Cordis Loader, published tool runtime and SQLite provider. They verify persistence, input failures, actor provenance, receipts, cancellation, native presentation and disposal. No model or live GitHub request is required.

## Project ownership

Automation belongs to the current session's registered Harness workspace. Its stable workspace ID is resolved host-side from the session header cwd; callers cannot select a project ID or create a workspace implicitly. Missing context rejects. Sessions in the same registered workspace share plans and subscriptions; different workspaces remain isolated. Background execution continues independently of the viewing session.

Legacy unassigned records are listed separately and require explicit claim into the current project. Claim pauses the record; resume is a separate action. GitHub storage capacity is shared across the host, not a project quota.

`scheduler_unassigned` lists legacy records; supplying `id` explicitly claims one into the current project.
