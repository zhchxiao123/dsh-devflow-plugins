# Agent Note: The judgement gate as Jev's only enforcement seat

Status: implemented

## Problem

The judgement layer (assess, audit, assistance) was complete but nothing in the enforcement path consumed it: admission and review gates ran full checker subagents, and judgement results reached humans only through the review panel. An earlier plan wired judgements into several points at once — agent-gate shadowing, review-gate triage, assistance triggers, a judgement cache (issues #35/#36/#40–#48). Review found the landing points scattered across three mechanisms and the whole hard to explain; the devflow architecture already has one policy plane, the transition waterfall.

## Decision

One new gate package, `devflow-jev-gate`, is the only place Jev judgements gain executive effect. It is a pure Consumer: `ctx.devflowJev.assess` supplies the rubric, evidence, and the persisted evaluation record; the gate binds judgements to configured `from->to` edges and writes one `GateCheck` line per assessment into the transition journal, naming the evaluation id so answers and later human accept/reject stay reachable.

Two modes per edge, and the module rule that orders them: a judgement can only lose its voice, never gain a veto it was not granted. `warn` records and always passes — warn records are the calibration data that must exist before anyone grants the model veto power. `enforce` vetoes only on a closed, explicitly configured condition set (release blocked-probability mass; confident high risk score), states the triggering numbers in the veto reason, and treats an unavailable judgement by the edge's explicit `failClosed` choice. An uncertain high risk score never vetoes: low confidence is a warning, not a block. Judgements run only after downstream policies allow the move, so no judgement is spent on a move another gate refuses.

Configuration fails loud at load: unknown stages, unknown assessment kinds, enforce fields on warn edges, and conditions without the assessment that answers them are boot failures.

## Alternatives considered

- The multi-point plan (#35): more coverage on day one, but three consumption mechanisms, three configuration surfaces, and a per-move shadow whose calibration data the warn mode now produces for free at transition granularity.
- Calling `ctx.jev` directly with a gate-owned rubric: independence from devflow-jev at the price of a second rubric to keep honest; rejected for reuse of the one rubric and its evaluation store.
- A `devflow-gates` required-validator instead of a listener: validators are mechanical repo commands with their own registry semantics; a judgement is not a command and warn mode has no place there.
- Shipping warn-only: rejected because the enforce contract (closed conditions, explicit failClosed, numbers in the reason) is the part that needs to be designed before data arrives, even if every deployment starts on warn.

## Consequences

The gate adds no seam, no storage, and no model-facing tool. Its records ride the journal (`gate.checks`) and the existing evaluation store; the calibration exporter (#38) reads both. Judgement latency lands on configured transitions only, bounded by the per-edge deadline. The rubric currently answers per-kind question sets from rubric v3; #37 (rubric v4) changes question wording and code-computed facts without touching this gate's contract, since conditions read stable answer ids (`releaseDecision`, `changeRisk`). Production enablement waits on #39, the proxied-connectivity proof.
