# Agent Note: Retire devflow-jev and devflow-jev-gate — keep the seam, drop the parked consumers

Status: implemented

## Problem

Five jev packages shipped, and the two largest — `devflow-jev` at 2740 lines of `src` and `devflow-jev-gate` at 408 — never changed what a session did. Assistance defaults to `observe`, which records judgements and delivers none of them; every gate edge starts at `warn`, which records a verdict and never vetoes; and no composition in this line mounts a `ctx.jev` provider, so both rows sat behind a seam nothing answered.

The shadow mode was deliberate — warn records are the calibration data that must exist before a model is granted veto power — but nothing closed the loop that would have ended it. `jev-triage` keeps no cross-session record by design, and the calibration export refused to summarize below 100 labeled rows, which a deployment recording nothing never reaches. Surface parked pending measurement, with no path to the measurement, stays parked and still moves with every harness bump.

## Decision

`packages/devflow-jev` and `packages/devflow-jev-gate` are deleted, together with the tooling that served only them: `scripts/jev-assistance/`, `scripts/jev-calibration.ts`, and `tests/jev-calibration.spec.ts`. `devflow-bundle` drops the `devflow-jev` row and its dependency; the `jev-runs` row stays, so domain-neutral durable runs and their tools are unaffected.

The seam keeps all three roles the conventions require: `jev` is the Service Definition, `jev-typesafe` the Service Provider, `jev-triage` the Consumer. `jev-triage` is the consumer worth keeping because its rule cannot fail expensively — a file is skipped only when it scored below `skipBelow` **and** the judgement was at or above `confidenceFloor`, so the worst case is a review nobody needed — and because its effect lands inside one code review instead of across a quarter of journal entries.

The `.agents/notes/` and `docs/reports/` records of the retired work stay where they are. They state decisions that were made; removing them would delete the history rather than the code.

## Alternatives considered

- **Cutting `devflow-jev` down to `devflow_assess` alone.** Keeps the evaluation store, the web transport, the sidebar, and the rubric — most of the 2740 lines — to expose one tool no composition currently calls.
- **Turning the defaults on instead** (`assistance.mode: assist`, enforce edges). Gives the model a voice in stage transitions on judgements whose accuracy was never measured against this repository. The calibration data has to exist first, and `jev-triage` collects it against cheaper consequences.
- **Leaving the packages in place, unmounted.** What they already were. The cost was never the mount; it is 3148 lines of `src` plus their tests, bilingual documentation pairs, and coverage obligations travelling with every harness bump.

## Consequences

The Judgements sidebar, project audits, request and card assessments, and judgement-recorded transitions are gone; a deployment that wants them restores them from git history, where they remain reachable and typechecked at the commit that removed them. The typed-judgement capability itself is intact and composable, with `jev-triage` as its whole consumer surface.

What the trade buys is that every remaining jev line has a caller: the definition has a provider, the provider has a consumer, and the consumer's effect is observable in the review it shortens. The measurement that was supposed to justify the retired rows is now the cheaper thing to collect, against the one consumer that survives.
