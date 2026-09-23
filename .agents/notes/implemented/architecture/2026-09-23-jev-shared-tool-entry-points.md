# Agent Note: Shared JEV entry points for tools and the review workspace

Status: implemented

## Problem

Separate tool names for every run kind and action force callers to choose between several lifecycle interfaces. Devflow audit jobs also had separate tool and HTTP launch implementations, allowing ownership, binding failure and retry behavior to diverge. A generic review could be inspected in the browser but could only be created through a tool definition.

## Decision

The generic run plugin registers `jev_run`, `jev_list`, and `jev_control`. Source adapters register through `ctx.jevRuns`; the generic package has no Devflow dependency. Devflow contributes audit and assessment sources and registers only `devflow_assess` and `devflow_decide_judgement`. The specialized `jev_triage` file-risk tool stays separate from this run lifecycle.

A list entry carries source, id and its original record. Reading one record requires source and id, avoiding collisions between stores. Assessment records are read-only through this interface; request/card assessment and proposal decisions remain in the Devflow adapter. An unavailable or unsupported source operation fails explicitly. Registrations have effect-scoped disposers.

The Devflow adapter shares assessment validation, decisions and audit job controls between tools and HTTP. Request and card assessment fields are mutually exclusive. Starting or resuming a job requires a live owner; cancellation retains Harness owner checks. A failed binding cancels the job it just created. Per-run serialization prevents concurrent lifecycle calls in one process from replacing each other's binding.

The review workspace offers generic evidence checklists, Devflow audits, new-request assessments and existing-card assessments. A checklist compiles supplied evidence and yes/no questions into the same durable generic definition accepted by tools. Advanced choice/score rubrics and separate evidence remain available through a full definition. The form does not collect repository files. See the [review workspace note](../feature/2026-09-22-jev-review-workspace.md) for presentation and scope semantics.

Old tool aliases are removed from model registration. Existing HTTP methods remain thin service adapters, and persisted `.jev` and `.devflow/judgements` records keep their formats and locations. Deploying the change requires rebuilding and restarting the local plugin composition.

## Alternatives considered

**Keep aliases registered.** This preserves the model's original overload of near-equivalent tools and does not deliver the smaller interface.

**Put Devflow branching in the generic engine.** This couples domain-neutral execution to task-card storage. Source adapters keep that dependency in the consumer.

**Make the browser invoke model tools.** HTTP and tools need different actor/session resolution; sharing the domain service preserves those boundaries without duplicating behavior.

## Consequences

Current callers must use the new tool names and source/id selectors; historical tool calls remain historical records. The UI and tools operate on the same durable data without a migration. Source registration is process-local, and lifecycle serialization does not claim distributed coordination. Provider credentials are still required for real judgement calls; successful validation of registration and routing is not evidence of provider quality.
