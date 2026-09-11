# Agent Note: the board offers only the decision a card is open to

Status: implemented

## Problem

[The board's write face](2026-09-10-board-archive-scope.md) states the rule it
was built on:

> Every row also carries the one decision its card is open to… Offering both
> would put a button on each row whose only possible outcome is a refusal.

It then broke that rule in three places, all found by using the board.

**A delivered slice offered filing that always failed.** `CardActionBar` read
`card.stage === 'done'` and nothing else, so a finished sub-requirement got an
archive control while its requirement was still open — where the store answers
`parent-active`, correctly: filing a slice first leaves its requirement counting
progress against a card nobody can see.

This is not an edge state. A slice finishing before its requirement is the
ordinary path, so the dead control was on screen for every decomposed
requirement, all the time.

**A requirement had no controls at all in the Kanban.** A requirement with
children is drawn as a swimlane, not a card, and `SwimlaneHeader` never took
`actions`. Filing and dropping a requirement both work — in the store, through
`/devflow`, and in the list view — but the Kanban offered neither. The write
face added controls to `KanbanCard` and `BoardCardRow` and missed the third
shape.

**Fixing that would have introduced the mirror image.** Since
[dropping a requirement started refusing unfinished slices](2026-09-10-dropping-a-requirement-keeps-its-slices.md),
a lane header with controls would offer a drop that answers `children-active`.

## Decision

`CardActions` gains `offered(card)`, returning the one decision that card is
open to or `none`, and `CardActionBar` renders nothing for `none`.

The predicate mirrors the store's two family rejections exactly:

| card | offered |
|---|---|
| `done`, requirement still on the board | `none` — `archive` answers `parent-active` |
| `done`, otherwise | `archive` |
| unfinished, a slice of it is unfinished | `none` — `abandon` answers `children-active` |
| unfinished, otherwise | `abandon` |

It is computed once per listing into two sets rather than scanned per card:
every row asks, and a scan per row makes the board quadratic in its own size.

`SwimlaneHeader` now takes `actions` and renders the bar, so a requirement
carries its decisions in the Kanban as it already did in the list.

### A row with no decision shows nothing, not a disabled control

The archive scope's view switch is *disabled with its reason shown* rather than
removed, on the grounds that a control which vanishes reads as a fault. The
opposite choice here is deliberate: that is one control in a toolbar, this is
one per row in the state every decomposed requirement passes through. The
structure already carries the explanation — a slice sits inside its
requirement's lane, and the lane header shows its `k/n`.

### This is about what to offer, not about what to allow

`AGENTS.md` puts enforcement in the operation that makes the decision. The
store's two rejections are untouched and still fire; this only stops the board
asking questions it knows the answer to.

That distinction is why this does not reopen the decision, taken one change
earlier, not to disable the drop control on a requirement. What was rejected
there was a client-side check standing in for enforcement. What this adds is a
choice the board was already making — it has always branched on
`stage === 'done'` to pick which control to draw — extended with the same
inputs the store uses.

### The mirror can drift, and that cost is real

The rule now exists in two places. A store rule changed without this one
offers a control that will be refused, or hides one that would work.

Nothing here prevents that; what limits the damage is that both failures are
soft. Offering too much degrades to the behaviour this replaced — the reader
gets the refusal message. Offering too little clears on the next read. Neither
loses work or writes anything.

## Consequences

- `CardActions.offered` is required, not optional. A default would have let a
  caller silently keep the old behaviour, which is the bug.
- `tsc -b` did not catch the test fixture missing the new member; the failure
  surfaced at runtime instead. The package's test files are outside that
  project, which is worth knowing before relying on a type change to find every
  call site.

## Not addressed

The question behind the report — how a requirement gets *closed* — is a
transition to `done`, not filing or dropping. The board offers no transitions
by design; that plane belongs to the model tools and `/devflow`, and this change
does not revisit it.

## Verification

- `tsc -b --force`, `oxlint`: clean.
- `vitest run`: 99 suites, 1323 tests, with one case per row of the table above
  plus the lane header carrying a requirement's controls.
- `test:coverage`: per-file 100%. `pnpm run build` and `preflight:tarballs` pass.
- Not covered by automation: whether a row with no control reads as considered
  rather than broken. That wants a real Web profile.
