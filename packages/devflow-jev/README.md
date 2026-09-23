# @zhchxiao123/dsh-devflow-jev

English | [中文](README.zh.md)

Project-scoped typed judgements for Devflow. The plugin registers model tools, stores immutable evaluations below `.devflow/judgements`, creates cards only after an explicit accept action, and contributes a native Judgements sidebar.

## Tools

- `devflow_assess` — evaluate a new request (`target: "request"`, title/body) or an existing card (`target: "card"`, id/assessmentKind). It never creates or moves cards.
- `devflow_decide_judgement` — accept or reject a proposal with `id` and `action`. Acceptance idempotently creates the proposed card.

The generic JEV runtime supplies the shared entry points:

- `jev_run` with `source: "devflow-audit"`, optional profile/maxCards starts an audit.
- `jev_list` lists installed sources together. Filter by `source: "devflow-audit"`, `"devflow-assessment"`, or `"devflow-assistance"`; add `id` for full details.
- `jev_control` with source/id/action resumes or cancels an audit or generic run.

Old assessment, judgement decision, and audit tool names are removed from registration. Existing durable records and the web transport remain compatible. The specialized `jev_triage` tool remains separate.

JEV failures are recorded as `unavailable`; they never create or move a card.

## Automatic development guidance

With Harness system-prompt support and a configured JEV provider, workspace sessions receive Devflow-specific guidance for their visible assessment tools. The agent can assess material new requests or existing card revisions during ordinary development without requiring the user to name JEV. Generic evidence reviews and project audits use the shared JEV tools when available. Guidance does not accept proposals, create duplicate cards, move stages, or replace required validators; existing authorization and gates still apply. Credentials and tool visibility are checked per session, and plugin disposal removes the contribution.

Treat this as guidance for the Harness agent, not an additional executor. An assembled prompt proves the instructions are present; actual natural-language task execution must separately demonstrate appropriate tool calls and useful evidence-based decisions.

## Automatic assistance

Automatic assistance is separate from prompt guidance. The default mode is `observe`: the plugin records bounded judgements at eligible development checkpoints without delivering advice or extending the agent turn. Set `assistance.mode` to `assist` to deliver advice through the current Harness agent; `off` disables these automatic hooks while keeping explicit tools and guidance available.

```yaml
- name: '@zhchxiao123/dsh-devflow-jev'
  config:
    assistance:
      mode: observe
      timeoutMs: 5000
      maxCallsPerTurn: 3
      maxSteersPerTurn: 1
      confidenceFloor: 0.75
      maxBytes: 24000
      maxFiles: 12
      maxFileBytes: 4000
      repeatThreshold: 2
```

These are the defaults. Configure the existing plugin row rather than adding a second instance. The observer recognizes supported development tools and events; arbitrary tools are not automatically classified. It collects bounded checkout evidence and real tool outcomes, records omitted coverage, and uses credential, cancellation, freshness, deduplication and budget checks. The Harness agent remains the executor; assistance cannot move a card or bypass validators. Ambiguous card identity or unverified dispatched-worktree ownership remains session-scoped.

Policy version 3 preserves the raw selected action and why it was delivered or held below the threshold. It selects an investigation target from supplied requirements and actual failed tool outcomes; that target remains an unverified suggestion, not a confirmed defect. A natural-language request or read-only shell command does not by itself trigger a remote judgement. A completed design artifact, actual post-baseline checkout change, repeated failure or completion checkpoint may do so within the configured budget. When `maxCallsPerTurn` is at least 2, intermediate checkpoints leave the final call available for completion or repeated failure. Switching from `observe` to `assist`, or restoring locally configured credentials, permits a new assessment of unchanged evidence within the remaining budget. Delivered advice and advice whose delivery is unconfirmed are not replayed for the same evidence, event, policy version and provider configuration identity.

The implementation spans three existing packages: `devflow-jev` owns assistance, `jev` supplies optional `configurationIdentity()` metadata for consumer cache invalidation, and `jev-typesafe` fingerprints the provider, model, endpoint and credential reference without including credential values. Configuration identity does not prove provider health or detect secret rotation behind an unchanged reference.

Evidence collection stays inside the canonical session working directory, including when it is a subdirectory of a larger repository. It does not expand into sibling projects. A local per-turn baseline omits unchanged pre-existing dirty files from later requests; its metadata is never sent to JEV. Large safe source files can contribute a bounded diff even when their full excerpt is excluded. Hidden, sensitive, unsafe and binary content remains excluded with visible gaps. Stable omissions no longer invalidate otherwise unchanged evidence. Truncated enumeration, unreadable metadata and concurrent changes prevent reuse; metadata freshness is not proof of complete code or test coverage.

Records persist in `.devflow/judgements/assistance/`. Query them with `jev_list source=devflow-assistance`, optionally adding `id`. This source is read-only and has no resume/cancel operation. The existing JEV Reviews panel adds an Automatic assistance filter and details; search by associated card ID, title, session ID or reason. It does not add a timeline inside the Devflow card detail panel.

Details distinguish observed, delivery unconfirmed, delivered, stale, cancelled, unavailable and budget-exhausted states from the observed outcome. Actionable advice stays visible; no-op, stale and other diagnostic records are collapsed by default and remain available on expansion. A stale record names the changed dimensions rather than presenting its old advice as current. Association failures are recorded without guessing a card. An unknown outcome remains unknown. A later action or passing check does not establish that the suggestion caused a fix, was adopted, or resolved the issue. Records preserve action-choice concentration (`actionConfidence`) separately from intervention-support probability (`justifiedProbability`); neither is proof of correctness. When a subsequent action or check is observed, its detail records the actual tool call ID and exit status when available, without claiming causation. The view shows task revision, trigger, advice, evidence references, gaps and elapsed time without publishing the full collected source evidence. Prompt delivery and deterministic tests do not establish a general development-speed benefit; that requires separate natural-task comparisons.

## Project audits

An audit snapshots the active board, samples cards across stages, and chooses checks from the selected profile. Planning, implementation risk, test impact, review scope, release readiness, and specification delta each use a distinct typed rubric. Evidence comes from the journal-derived card, its complete history, registered artifacts, and parent/child summaries. Artifact reads remain inside the card directory, reject credential-bearing paths and symbolic-link escape, and have strict byte budgets.

Runs persist below `.devflow/judgements/audits/<run-id>/`. The immutable manifest fixes card revisions, evidence digests, rubric versions, and planned checks; mutable state commits after every check. Typed calls execute through the domain-neutral `JevRunEngine`; this package only supplies Devflow evidence, rubrics, findings, and UI projection. Harness jobs provide live output and cancellation, while the project files survive restart. A stranded `planned` run without a job or a stranded `running` run becomes `interrupted` and resumes only after an explicit request. Completed checks with unchanged identities are not replayed.

The JEV Reviews sidebar combines generic runs, Devflow audits, and individual assessments in a searchable workspace view. Details show explicit coverage, pending checks, errors, question results, evidence, and next steps. Devflow audits sample unfinished tasks and registered artifacts; they do not scan the whole repository. Generic runs retain their own subject and question definitions. Audits never create cards or move stages. Request proposals show the proposed task before the explicit accept action.

The New review form supports a generic checklist with supplied evidence, a Devflow audit, a new request, or an existing task assessment. Generic checklist questions are yes/no conditions; richer choice/score questions use `jev_run` with a full definition. Generic forms do not collect repository files. Tools and web controls share the lifecycle and assessment services.
