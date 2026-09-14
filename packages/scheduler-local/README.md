# Local scheduler

SQLite provider for `ctx.scheduler`, requiring Node.js 24 or later. It runs while the host is alive and does not require an active agent. Stop the host and execution stops; restart reconstructs persisted pending work.

Configuration:

| Field | Default | Meaning |
| --- | --- | --- |
| `databasePath` | `.scheduler/scheduler.sqlite` | Durable SQLite database on a local filesystem |
| `pollIntervalMs` | `1000` | Due-work and downstream-status polling |
| `leaseMs` | `30000` | Execution ownership lease |
| `retryMs` | `1000` | Failed delivery/status retry delay |

Use `/scheduler create <JSON>`, `/scheduler update <id> <JSON>`, `/scheduler list`, `/scheduler history [planId]`, `/scheduler pause/resume/remove/trigger <id>`, and `/scheduler cancel <triggerId>`. Commands appear only when the Harness commands service is loaded.

A plan input contains `name`, `handler`, JSON `params`, and either `rule: { kind: "interval", everyMs: 60000 }` or `rule: { kind: "cron", expression: "30 9 * * 1-5", timezone: "Asia/Shanghai" }`. Optional `misfire` is `latest` (default) or `skip`; `maxAttempts` defaults to 3 and `timeoutMs` to 30000.

Interval schedules preserve the original anchor. Cron uses five fields and an IANA timezone, skips nonexistent local times, and avoids duplicated fallback occurrences. Multiple missed cycles do not produce unbounded catch-up. Pausing/removing a plan prevents future deliveries but does not cancel an accepted downstream run. Explicit trigger cancellation delegates to the handler; previously committed downstream data remains owned by that handler.

Instances sharing one local SQLite database coordinate using leases and generations. Old owners cannot commit after expiry or takeover. This is not a cross-machine or network-filesystem execution cluster. SQLite retains plan and trigger history; no automatic historical cleanup occurs.

Delivery failures persist generic error codes rather than handler exception bodies. Keep secrets out of generic plan parameters; the scheduler cannot infer which arbitrary JSON values are secrets.

Plan parameters are copied before handler validation and persistence. Only lossless plain JSON values are accepted; functions, symbols, BigInt, nested undefined, nonfinite numbers, negative zero, accessors, proxies, custom prototypes, sparse/extended arrays and cyclic values are rejected before a plan is written. Handler validation receives a separate copy, so it cannot change the validated persistent snapshot.
