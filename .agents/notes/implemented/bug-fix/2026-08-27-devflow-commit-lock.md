# Agent Note: devflow — the checks and the append happen under one lock

Status: implemented

English | [中文](2026-08-27-devflow-commit-lock.zh.md)

## Problem

Every check a transition makes — the revision compare-and-set, the edge legality, the rework reason — ran against a card read at the top of `commitTransition`, and the append that acted on those checks came after the `devflow/transition` waterfall. That waterfall is where a deployment's gate commands run. With `'developing->reviewing': ['pnpm run test']` configured, the distance between "revision 3 is current" and "write revision 4" is however long the test suite takes.

`serialized()` closes that window inside one provider instance. It does nothing across instances, and two processes over one root are the ordinary case: a harness and a `/devflow` invocation, two harnesses, a checkout shared with CI. Both read revision 3, both pass every check, both append revision 4.

The result is not a lost update. `foldJournal` requires contiguous revisions and requires each transition to depart the location the previous entry arrived at, so the second append makes the journal **structurally invalid** — and the store's read path is deliberately fail-loud. The card becomes permanently unreadable, and the journal is the authority, so nothing else can recover it. A single card's history is the one thing this design promises to keep.

The same gap breaks legality independently of revisions: a card parked `blocked` during a gate still receives the move the gate approved, written with a `from` the card no longer sat at.

## Decision

**A commit lock spans the re-check and the append, and nothing else.** After the waterfall decides, `committing()` takes `commit.lock` in the card directory with an `O_EXCL` creation, re-reads the journal's revision, and appends only if it still equals the revision every earlier check ran against. Unchanged revision proves the whole check block still holds, because a card's location only moves with its revision.

The lock deliberately does **not** cover the caller's checks or the waterfall. Gate commands take minutes; a lock held across them would queue unrelated commits behind a test suite, and would turn every crashed gate into a stuck card.

A caller that loses this race gets `revision-mismatch`, the code it already had to handle, with a message naming the gate as the reason the card moved underneath it. A caller that never gets the lock gets a new `write-contended`: nothing was written, and the move can be retried unchanged.

Alternatives considered:

- **Require the caller to hold the card's lease.** The investigation says no: of the write paths, only `devflow_take` and the driver claim at all. `/devflow move`, plain `devflow_transition`, and every `attachArtifact` do not, so the rule could only ever warn — leaving the corruption open — or break three of five callers. Worse, the driver holds its lease as `{kind:'command'}` while the child that writes is `{kind:'agent'}`, so an identity comparison would reject the one consumer using leases correctly.
- **Append first, then verify and roll back.** The journal is append-only; a truncating rollback gives that up, and `foldJournal` would see the intermediate state anyway.
- **Re-check without a lock.** Narrows the window from minutes to microseconds but does not close it, and what leaks through is unrecoverable data loss rather than a retry.

The lock's staleness window and retry budget are fixed constants rather than `Config` fields. They bound an internal critical section of one read and one append; a deployment has nothing to tune, and a window long enough to matter would mean the lock is being held somewhere it should not be.

## Consequences

`TransitionRejectionCode` and `ArtifactResult`'s code union each gain `write-contended`. No consumer in this line switches exhaustively over either, so the addition is compatible; a consumer that does will need a case.

Concurrent commits on one card now serialize across processes rather than corrupting. Commits on *different* cards are unaffected — the lock is per card directory, matching `serialized()`'s root + id key.

A process killed between taking the lock and releasing it leaves the file behind. The next commit breaks a lock older than the staleness window, so recovery needs no operator action; the previous behavior in that situation was a half-written commit, which was worse and silent.

`transition-contention.spec.ts` is the case that motivated all of this: it holds the waterfall open the way a gate does, commits from a second instance, and asserts the first commit is refused and the card stays readable. Before the fix it asserted the opposite and passed.
