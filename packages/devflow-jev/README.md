# @zhchxiao123/dsh-devflow-jev

Project-scoped typed judgements for Devflow. The plugin registers model tools, stores immutable evaluations below `.devflow/judgements`, creates cards only after an explicit accept action, and contributes a native Judgements sidebar.

## Tools

- `devflow_assess_request` — evaluate a proposed task before creating it.
- `devflow_assess` — evaluate an existing card against its current revision.
- `devflow_judgements` — list or read durable evaluations.
- `devflow_accept_judgement` — idempotently create the proposed card.
- `devflow_reject_judgement` — reject a pending proposal.

JEV failures are recorded as `unavailable`; they never create or move a card.
