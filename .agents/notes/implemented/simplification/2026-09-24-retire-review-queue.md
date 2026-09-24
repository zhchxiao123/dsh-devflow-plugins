# Agent Note: Retire the review queue — the judged action creates the card

Status: implemented

## Problem

Jev was brought in to reduce human review, yet the intake path manufactured it: `decide()` folded raw judgements into decision vocabulary, and every borderline case parked in a "manual review" queue waiting for a click. The user's critique was exact — the raw judgement (value 2.17, risk 2.84, investigate 90%) was already the useful artifact, and the abstraction on top of it converted data back into work.

## Decision

`policy.autoCreate` (default on): a request assessment whose judged `recommendedAction` is `create` or `investigate` becomes a card the moment it is judged, signed `by: command`. Floors keep informing the recorded decision but no longer gate creation — a card is cheap and abandonable, and abandoning one feeds calibration exactly the label a review click would have. `ask` and `reject` create nothing; provider failure creates nothing; cards start at `draft`, because plugins do not advance stages. The explicit accept/reject channel survives for `autoCreate: false` deployments, and `acceptOnce` now accepts any open proposal rather than only `propose`-decided ones — a human overriding the floors is legitimate.

The list shows the judgement, not the vocabulary: summaries carry `keyAnswers` (value, risk, action, action probability), an open judgement's badge is its judged action, and the excerpt is one line of raw numbers. Only a proposal still awaiting its explicit verdict counts as actionable.

## Alternatives considered

- Loosening the floors instead: keeps the queue and the vocabulary; the objection was to the abstraction, not the constants.
- Auto-transitioning investigate-cards into `designing`: rejected — the Harness agent is the sole workflow executor; creation is mechanical intake, transition is workflow.

## Consequences

Under autoCreate nothing waits on a human: judged work appears as draft cards, unwanted cards get abandoned, and both movements label the calibration data. The five-value decision vocabulary survives only as recorded data on the evaluation. Deployments that want the old gatekeeping set `autoCreate: false` and keep the explicit channel.
