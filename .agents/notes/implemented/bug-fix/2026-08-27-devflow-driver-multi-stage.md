# Agent Note: devflow — the driver drives every stage, not just the first

Status: implemented

English | [中文](2026-08-27-devflow-driver-multi-stage.zh.md)

## Problem

`Config.stages` is a map, and [the bundle's own example](../../../../packages/devflow-bundle/README.md) configures more than one entry — but a card only ever reached the first of them. The `engaged` set carried two meanings whose correct lifetimes differ: *queued* (enqueue → dequeue) and *being driven* (dispatch → child exit). One set held the longer of the two, so the `devflow/stage-changed` a running child raised for its own move arrived while its card was still engaged and the listener discarded it as a duplicate. By the time `drive()` released the key, the queue was empty and nothing re-entered the card. Only a process restart, whose activation sweep re-reads the board, moved it again.

Per-file 100% coverage did not catch this. Every driver spec settled its child and stopped; the stage moves they did make went through `store.transition` from outside a dispatch, so no test ever had a card advance *while engaged*. Line coverage covers code, not the edges of a state machine.

Two smaller defects sat in the same file. `park()` re-read the card to fill its own `expectedRevision`, which makes the compare-and-set unconditional: a child that advanced its card and then failed had whatever stage it reached blocked instead, recording a recovery point the card never departed. And a revision regression — the branch-switch case — rescanned the store's default root rather than the root the regressed card came from, so a secondary root's board was never the one re-read.

## Decision

**`engaged` keeps its dispatch-to-exit lifetime; the card re-enters through a re-read.** When `drive()` settles, the driver reads the card once more and enqueues it if its revision moved. `enqueue` already refuses undriven stages, so a card that finished at `done`, at `blocked`, or at any unconfigured stage stops there by itself.

Alternatives, both rejected:

- **Release `engaged` at dispatch and let the lease prevent a second child.** The smaller change, and the right end state — but the lease is advisory today: no write path reads `claim.json`, and a failed `claim` makes `drive()` return without requeueing. Resting correctness on that is resting it on a guarantee the store does not yet make.
- **Key `engaged` by revision as well as card.** It stops the event being discarded, but nothing then stops the new stage's dispatch from starting while the old stage's child is still alive — two children on one card. That trades a stall for a race, and the set grows without bound.

**`park()` uses the revision the card was dispatched at.** A `revision-mismatch` is no longer a failure to report: it is the executor telling us it advanced the card before it died, so the card is left where it stands and the mismatch is logged at `debug`. Only a genuine parking failure still warns.

**The regression rescan takes the card's own root.** `sweep()` accepts an optional root and the listener passes `card.root`. The activation sweep still reads only the default root, which stays a documented limitation rather than a defect: the seam exposes no operation that enumerates roots, so a card parked in another root at activation genuinely cannot be found — it enters through its next event.

## Consequences

**A deployment configuring more than one driven stage will now spend model budget it did not spend before.** The stall was silent, and anyone whose stage map lists several stages has been getting one dispatch per card per process. That is the intended behavior arriving, not a new cost — but it arrives without a configuration change, so it belongs in the release notes.

A card now costs one extra read per completed dispatch. The read is off the dispatch path, after the slot is already freed for queued cards, so it delays nothing.

Three specs were added, each of which fails without its fix: a child advancing its card mid-dispatch draws a second dispatch; an executor that advances and then fails leaves its card alone; a regression in a secondary root rescans that root. They are the first driver specs that exercise a move *arriving during* a dispatch rather than between two of them.
