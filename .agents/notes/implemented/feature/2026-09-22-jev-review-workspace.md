# Agent Note: JEV review workspace shows scope before verdict

Status: implemented

## Problem

A list of internal assessment kinds, decision codes, and confidence percentages does not tell a developer what was reviewed or what to do next. Generic JEV runs also need a visible home alongside Devflow audits and individual assessments. Without an explicit distinction between execution and findings, a completed provider call can look like a passed project review.

## Decision

The native JEV Review sidebar is a session-scoped workspace with project context, search, and filters for all records, generic runs, Devflow audits, and individual assessments. Chinese and English labels describe the purpose and state of each record. The page uses the Harness theme tokens and supports narrow sidebars and expanded layouts.

Details separate execution status, coverage, findings, and suggested next steps. The checklist includes every planned check, including checks without results. Typed question answers and collected evidence are readable in the detail view; raw values remain available where a custom subject or template has no built-in label. Confidence describes a judgement, not review progress or proof that a project is correct. A generic run supplies individual answers without an invented aggregate verdict.

The HTTP route resolves the workspace from the current session. `context` returns the project name, path, and generic-run availability; `run-list`, `run-read`, `run-resume`, and `run-cancel` operate on that workspace's `.jev` records. Missing generic-run service is explicit. Reads can use persisted session context; resume and cancellation require a live agent. The generic service shares lifecycle methods between tools and HTTP, serializes controls for each run, waits for job binding and runner startup, and preserves Harness owner checks on cancellation. A failed binding cancels the newly created job.

Creation forms support Devflow card audits, proposed-request assessments, existing-card assessments, and generic evidence checklists. Tools and HTTP use the [shared entry-point services](../architecture/2026-09-23-jev-shared-tool-entry-points.md). Devflow audits inspect registered card evidence; the page does not claim repository-wide source collection or a catalog of executable generic templates. Audit behavior is owned by the [durable project audits note](2026-09-22-jev-project-audits.md).

## Alternatives considered

**Keep separate raw record lists.** This leaves developers to infer coverage and meaning from internal fields and keeps generic runs undiscoverable.

**Treat successful execution as a passing review.** This confuses provider availability with the substance of its answers and hides pending checks and missing evidence.

**Build a second browser-owned runner.** Sharing the generic service keeps tool and browser actions on the same durable records and owner-scoped Harness jobs.

## Consequences

The UI makes existing evidence reviewable while retaining distinct domain interpretations. It cannot turn missing evidence into verification, automatically collect repository files, or advance a Devflow card by displaying a judgement. The lifecycle lock coordinates controls within one service process; it is not a distributed filesystem lease.

Client behavior tests cover list and detail presentation, pending checks, explicit coverage, forms, and stale requests. The real Loader/HTTP/jobs composition test covers generic discovery, concurrent resume, cancellation, recovery, workspace isolation, missing services, and owner rejection. Browser and installed-runtime acceptance remains separate from these automated checks.
