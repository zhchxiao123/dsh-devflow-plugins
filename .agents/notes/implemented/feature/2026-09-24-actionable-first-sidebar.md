# Agent Note: Actionable-first sidebar and outcome-derived labels

Status: implemented

## Problem

The judgement sidebar spoke internal state-machine vocabulary at users, and most of what it showed asked nothing of them. A user wanting automation read every card as a demand; the one queue that did ask — manual review — depended on clicks nobody made, which also starved the calibration exporter of labels.

## Decision

The default view answers one question: is there anything to act on? Actionable means a request proposal awaiting its verdict, an audit whose conclusion is blocked, or deliverable assistance advice. Everything else — run states, finished audits, settled or unavailable judgements — folds into the existing diagnostics collapse, where a kind tab or the toggle still reaches it. An all-quiet view says so in one line.

Labels come from outcomes instead of clicks. When a card reaches `done`, the service stamps its open card-scoped advice `accepted` — the event exists and the semantics are exact. Abandonment emits no event, so the runtime leaves those records alone and the calibration exporter derives the `rejected` side from the journal's `abandoned` entries at export time, which also labels records written before this change. Exported rows carry `labelSource` (`verdict` or `outcome`) so calibration can weigh the two differently. A human verdict recorded first is never overwritten, and request proposals keep waiting for their explicit decision — accepting one creates a card, a consequence that keeps its deliberate one-click distance.

**Archive was rejected as the rejection signal**: the store archives only `done` cards, so `card-archived` means delivered, and mapping it to `rejected` would have mislabeled every archived delivery.

## Alternatives considered

- Runtime rejection stamping on an abandonment event: no such event exists, and inventing one upstream fails the published-surface rule; the exporter reads the journal instead.
- Deleting the folded states: they are real and operators debug with them; folding changes the audience, not the record.

## Consequences

The sidebar is near-empty in a healthy project, and a visible card means something needs a decision. Settling is fail-quiet by design — an unwritable record never disturbs the transition that triggered it, proven by test. Manual review remains possible but stops being load-bearing: labels accumulate from work people already do.
