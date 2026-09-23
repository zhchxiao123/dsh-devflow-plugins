# Agent Note: JEV project audits are durable evidence runs

Status: implemented

## Problem

A judgement over one card body can answer whether a request looks actionable, but it cannot establish project delivery health. Planning, implementation risk, testing, release readiness, and specification drift require different questions and different evidence. Repeating the single-card tool by hand also loses coverage, progress, cancellation, and restart history.

## Decision

`devflow-jev` owns project audits as durable read-only runs. One audit snapshots the complete active Devflow board, samples cards across stages, collects the journal-derived card, complete journal, registered artifacts, and parent/child summaries, then plans stage-appropriate checks from a named profile. Each assessment kind has its own typed questions. Model answers remain per-check evidence; deterministic code derives coverage, missing evidence, release blockers, high implementation risk, specification gaps, and parent-child conflicts.

The immutable manifest fixes card revisions, evidence digests, rubric versions, and check identities. State commits after every check under `.devflow/judgements/audits/<run-id>/`, alongside per-check evaluations and the terminal report. Harness jobs provide owner-scoped progress and cancellation, while the project files are the restart authority. A run left `running` without a live runner becomes `interrupted`; explicit resume retries unfinished or stale checks and preserves only completed checks whose evidence digest and rubric identity still match; expired checks are reported explicitly as `stale`.

Registered artifact paths are untrusted. Collection stays under the card directory, rejects traversal, symbolic-link escape, credential-bearing file names, non-files, and files beyond the byte budget. A gap is evidence in the report rather than a reason to scan elsewhere. Audits never execute repository commands, create cards, or move stages.

The native Judgements page separates Project Audits from Individual Judgements. Both the model tools and the session-scoped HTTP page operate on the same durable runs.

## Alternatives considered

**A new project-audit package.** Rejected because audit planning, evidence, evaluations, proposal judgements, persistence, tools, and the existing panel share one ownership seam. Splitting them would expose internal coordination interfaces without an independent consumer.

**One large model request for the whole project.** Rejected because it has no per-card commit point, exceeds evidence budgets quickly, cannot resume safely, and makes one provider failure erase all progress.

**Using one universal question set with an assessment label.** Rejected because the label does not change what is judged. Release evidence, test freshness, implementation risk, and specification coverage need different typed questions.

**Automatically moving cards or creating remediation cards.** Rejected because an audit is advisory evidence. Workflow mutation remains an explicit human or agent action after inspecting a finding.

## Consequences

Audits can be long and may consume many provider calls, but their progress is visible and partial work survives restart. Artifact budgets can report a large useful document as oversized; the remedy is to register a focused report rather than silently widening the trust and token boundary. The first implementation reads registered Devflow evidence and does not run tests or scan arbitrary source files, so it can identify missing proof but cannot manufacture proof.

Unit, client, and real Loader/HTTP/jobs composition tests cover distinct rubrics, durable completion, cancellation and resume, card immutability, findings, owner isolation, and native panel actions. Full build and installed-runtime checks prove the package, browser artifact, tools, and session-scoped route compose together.
