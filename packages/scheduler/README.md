# Scheduler service

The `ctx.scheduler` definition supplies host-level durable plans independently of chat sessions. Load a provider such as `@zhchxiao123/dsh-scheduler-local` and register a handler through this service.

Handlers implement `validate(params)`, `accept(delivery)`, `status(runId)` and `cancel(runId)`. Register them in a Cordis effect and return the disposer. `accept` must durably deduplicate by `delivery.triggerId` before returning `{ runId }`. Receipt loss retries the same trigger identity. A receipt means accepted; only `status` can mark downstream work completed, partial, failed or cancelled. Implement cancellation idempotently.

Management operations accept a caller identity: `create`, `update`, `pause`, `resume`, `remove`, `trigger`, and `cancel`. `list` and `history` expose committed records; `tick` requests immediate reconciliation. Different manual requests have distinct identities and wait in order; periodic requests coalesce while a plan remains busy.

The service has no GitHub or Devflow dependency. Parameters are JSON data and must not contain credentials; use credential references owned by the receiving handler.

`delivery.cancelRequested` is mandatory. When true, acceptance must atomically persist a cancellation tombstone keyed by the trigger ID, or cancel the existing durable run, and return its run ID without starting new work. A later ordinary acceptance of that same ID must observe the tombstone. Receipt ambiguity must never create work after cancellation. Until this acknowledgement arrives, the scheduler retains `CANCELLATION_UNRESOLVED` and retries without declaring cancellation complete or exhausting into a false terminal failure.
