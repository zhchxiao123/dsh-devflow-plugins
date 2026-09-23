# @zhchxiao123/dsh-devflow-jev

Project-scoped typed judgements for Devflow. The plugin registers model tools, stores immutable evaluations below `.devflow/judgements`, creates cards only after an explicit accept action, and contributes a native Judgements sidebar.

## Tools

- `devflow_assess_request` — evaluate a proposed task before creating it.
- `devflow_assess` — evaluate an existing card against its current revision.
- `devflow_judgements` — list or read durable evaluations.
- `devflow_accept_judgement` — idempotently create the proposed card.
- `devflow_reject_judgement` — reject a pending proposal.
- `devflow_audit_project` — start a durable, read-only, stage-aware project audit as a Harness job.
- `devflow_audits` — list or inspect persisted audit runs.
- `devflow_resume_audit` — resume unfinished checks after cancellation, interruption, or partial failure.
- `devflow_cancel_audit` — cancel the owner-scoped Harness job for a running audit.

JEV failures are recorded as `unavailable`; they never create or move a card.

## Project audits

An audit snapshots the active board, samples cards across stages, and chooses checks from the selected profile. Planning, implementation risk, test impact, review scope, release readiness, and specification delta each use a distinct typed rubric. Evidence comes from the journal-derived card, its complete history, registered artifacts, and parent/child summaries. Artifact reads remain inside the card directory, reject credential-bearing paths and symbolic-link escape, and have strict byte budgets.

Runs persist below `.devflow/judgements/audits/<run-id>/`. The immutable manifest fixes card revisions, evidence digests, rubric versions, and planned checks; mutable state commits after every check. Harness jobs provide live output and cancellation, while the project files survive restart. A stranded `running` state becomes `interrupted` and resumes only after an explicit request. Completed checks with unchanged identities are not replayed.

The Project Audits tab shows progress, conclusion, errors, and deterministic findings. Audits never create cards or move stages. Individual request proposals retain the separate explicit accept path.
