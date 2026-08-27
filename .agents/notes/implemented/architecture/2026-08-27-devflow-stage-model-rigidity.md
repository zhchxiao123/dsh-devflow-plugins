# Agent Note: devflow — verification can send a card back to design, and the other two rigidities stay

Status: implemented

English | [中文](2026-08-27-devflow-stage-model-rigidity.zh.md)

## Problem

`FLOW` in [`stages.ts`](../../../../packages/devflow/src/stages.ts) is the hardest table in this line to change: the closed `DevStage` union, journal replay, gate edge keys, driver dispatch, and the board's rendering all stand on it. Three properties of it were raised as possibly too rigid, and the point of this note is to say which of the three was, so the question stops being reopened.

1. **No skip edges.** Every card walks all seven stages. A one-line copy fix passes through `designing` and `ready`.
2. **Rework only reaches `developing`.** `reviewing` and `testing` can send a card back, but only to one place. A design fault found in testing has nowhere truthful to go.
3. **`done` is terminal.** A regression on delivered work can only start a new card.

## Decision

**Only the second is a defect, and it is fixed.** `reviewing` and `testing` now also reach `designing`, and both count as rework, so the move still requires a `reason`.

The argument is the PRD's own goal for having stages at all: *"so that at any moment you can answer where this thing is."* Before this change, a card whose design turned out to be wrong had two options — sit in `developing` while design work happened, or be parked `blocked` (which must recover to the exact stage it interrupted, so it could only come back to `testing`). The first makes the board say `developing` about a card nobody is implementing. A board that misreports where work is fails at the one thing it was built for, and no amount of care in the surrounding machinery compensates.

The change is additive. `FLOW` gains two entries and loses none — which is the only safe direction, because removing an edge makes every journal that already used it fail replay.

**Skip edges: no.** The uniform pipeline is the product, not an accident of it. The cost of a trivial card is six moves and six journal entries, which is real but small, and the benefit is that "where is this" has the same answer shape for every card. A skip edge, once available, becomes the default path — and a deployment that genuinely wants a shorter pipeline can leave the intermediate stages ungated and undriven, which costs the moves and nothing else.

**Reopening `done`: no.** This one looked like a contradiction — the archiver goes to real trouble to keep a decomposed requirement's history in one month bucket, so history clearly matters — and on inspection it is not one. A regression found in production is new work about old code, not a continuation of a requirement that was in fact delivered. More concretely, reopening would have to reach cards that `archiveDone` has already moved, and [the seam's archive is write-only by design](../feature/2026-08-25-devflow-file-based-task-cards.md): no operation lists or restores an archived card. Making `done` non-terminal therefore is not an edge in `FLOW` but a new read face over the archive, with its own PRD.

## Consequences

`testing -> designing` and `reviewing -> designing` become configurable gate edges and driveable dispatch targets for free, because both are keyed by the same `from->to` string as every other edge. A deployment that drives `designing` will now re-dispatch a card that comes back to it, which is the intended behavior and worth knowing before turning the driver on.

`isReworkEdge` widening means those two moves are rejected `reason-required` without a stated reason, like the existing pair. That is the point: the next holder needs to know what about the design was wrong.

The two "no" answers are recorded here so the next person weighing them starts from the reasoning rather than from the observation. The observation — that the pipeline is strict and `done` is a wall — is correct; it is the intent.
