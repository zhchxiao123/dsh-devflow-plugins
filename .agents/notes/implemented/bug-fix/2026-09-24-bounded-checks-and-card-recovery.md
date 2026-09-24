# Agent Note: Bounded judgement checks and card-level recovery

Status: implemented

## Problem

Sidebar cards read "interrupted" constantly, at `0/N` processed. The chain: a judgement check had no deadline of its own, so a hanging provider parked a run in `running` for minutes; the development harness restarts often; `recover()` then honestly marked every orphaned run interrupted; and resuming took a trip into the detail view nobody made. Meanwhile an `unavailable` evaluation quoted the provider's English prose, and a finished audit wore the decision-free "execution ended" badge, so the sidebar read as jargon.

## Decision

Bound the cause, surface the recovery, keep the executor rule.

`JevRunDefinition` gains `checkTimeoutMs`: a check past its deadline records a `JEV_TIMEOUT` failure and the run moves on, finishing as `completed-with-errors` in bounded time instead of holding the interruption window open. Caller cancellation keeps its meaning through the run signal — and, when no deadline is configured, a provider-side `JEV_ABORTED` still cancels, exactly as before. Audits and single assessments take the deadline from `policy.judgementDeadlineMs` (default 60s: three transport attempts at the 20s SDK deadline); generic runs from the `jev-runs` plugin config. The store validates the field at the file boundary.

The panel makes recovery one click: resumable run and audit cards carry the resume button on the card itself, with a line saying a restart caused the interruption and that finished checks survive. A finished audit shows its conclusion where the run status badge sat — "execution ended" decides nothing and no longer appears once a conclusion exists. An `unavailable` evaluation names its failure class from the `JevError` code (timeout, rate-limited, unreachable, credential missing, …) instead of provider prose.

**Automatic resume at boot was rejected**, though issue #50 originally asked for it: the Harness agent is the sole workflow executor, and a plugin relaunching judgement API calls with no owning agent is a second background orchestrator by another name. Resume therefore stays human- or agent-initiated — the card button and `jev_control resume` — and the deadline work removes most occasions for it.

## Alternatives considered

- Auto-resume on panel open: still automation spending API budget on a view render; rejected with boot-time resume.
- A run-level deadline instead of per-check: one budget for N checks starves the tail; per-check keeps every judgement's bound identical and the failure attributable.
- Inline accept/reject on evaluation list cards: accepting creates a card; that consequence keeps its one-click distance in the detail view deliberately.

## Consequences

Interruptions become rare (a run now ends in bounded time) and cheap (one click, finished checks retained). `completed-with-errors` grows more common than `interrupted` under a flaky provider — an honest trade, since it is resumable and names each failed check. Deployments wanting the old unbounded waits can raise `judgementDeadlineMs`/`checkTimeoutMs`. The calibration exporter sees `JEV_TIMEOUT` rows it previously lost to interruption.
