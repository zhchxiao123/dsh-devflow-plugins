# @zhchxiao123/dsh-devflow-jev

Project-scoped typed judgements for Devflow. The plugin registers model tools, stores immutable evaluations below `.devflow/judgements`, creates cards only after an explicit accept action, and contributes a native Judgements sidebar.

## Tools

- `devflow_assess` — evaluate a new request (`target: "request"`, title/body) or an existing card (`target: "card"`, id/assessmentKind). It never creates or moves cards.
- `devflow_decide_judgement` — accept or reject a proposal with `id` and `action`. Acceptance idempotently creates the proposed card.

The generic JEV runtime supplies the shared entry points:

- `jev_run` with `source: "devflow-audit"`, optional profile/maxCards starts an audit.
- `jev_list` lists installed sources together. Filter by `source: "devflow-audit"` or `"devflow-assessment"`; add `id` for full details.
- `jev_control` with source/id/action resumes or cancels an audit or generic run.

Old assessment, judgement decision, and audit tool names are removed from registration. Existing durable records and the web transport remain compatible. The specialized `jev_triage` tool remains separate.

JEV failures are recorded as `unavailable`; they never create or move a card.

## Project audits

An audit snapshots the active board, samples cards across stages, and chooses checks from the selected profile. Planning, implementation risk, test impact, review scope, release readiness, and specification delta each use a distinct typed rubric. Evidence comes from the journal-derived card, its complete history, registered artifacts, and parent/child summaries. Artifact reads remain inside the card directory, reject credential-bearing paths and symbolic-link escape, and have strict byte budgets.

Runs persist below `.devflow/judgements/audits/<run-id>/`. The immutable manifest fixes card revisions, evidence digests, rubric versions, and planned checks; mutable state commits after every check. Typed calls execute through the domain-neutral `JevRunEngine`; this package only supplies Devflow evidence, rubrics, findings, and UI projection. Harness jobs provide live output and cancellation, while the project files survive restart. A stranded `planned` run without a job or a stranded `running` run becomes `interrupted` and resumes only after an explicit request. Completed checks with unchanged identities are not replayed.

The JEV Reviews sidebar combines generic runs, Devflow audits, and individual assessments in a searchable workspace view. Details show explicit coverage, pending checks, errors, question results, evidence, and next steps. Devflow audits sample unfinished tasks and registered artifacts; they do not scan the whole repository. Generic runs retain their own subject and question definitions. Audits never create cards or move stages. Request proposals show the proposed task before the explicit accept action.

The New review form supports a generic checklist with supplied evidence, a Devflow audit, a new request, or an existing task assessment. Generic checklist questions are yes/no conditions; richer choice/score questions use `jev_run` with a full definition. Generic forms do not collect repository files. Tools and web controls share the lifecycle and assessment services.
