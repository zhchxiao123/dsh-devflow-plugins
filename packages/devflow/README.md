# @zhchxiao123/dsh-devflow

English | [中文](README.zh.md)

Service Definition for the **`ctx.devflow` capability seam**: file-backed task cards moving through a fixed development pipeline. This package owns the card vocabulary (`DevCard`, `DevStage`, journal entry types, the branded `DevflowCardId`) and the journal decode/replay shared by every consumer. Storage belongs to a provider such as [`dsh-devflow-filesystem`](../devflow-filesystem/README.md); the model-facing tools are [`dsh-tool-devflow`](../tool-devflow/README.md).

## Service

`DevflowStore` is an abstract Cordis `Service` on `ctx.devflow` (one implementation per context; a second registration throws).

Every operation carries an explicit **devflow root** dimension: reads take an optional trailing `root`, requests carry an optional `root` field resolved into their spec, and `ClaimOptions` carries one for the lease. An omitted root falls back to the implementation's configured default, so single-root deployments never mention it; a returned `DevCard` always names the resolved `root` it belongs to, and cards with equal ids under different roots are different cards. Which root a caller passes is the caller's decision — the model tools and `/devflow` derive `<session cwd>/.devflow` from the invoking session, and the seam itself never maps workspaces to directories. The session-scoped reads are the one exception, because their caller is a browser that must never send paths: `listForSession` and `detailForSession` take the *viewing session's id* and resolve it host-side (the live or persisted session's header cwd, through the optionally composed `sessions`/`sessionPersistence` services) into the same root dimension; an unknown session is a stable rejection. `detailForSession` aggregates one card's read value, its decoded journal, and its lease holder (`DevCardDetail`) in a single round trip for the board's detail view, re-reading once when a transition tears the pair. [`dsh-devflow-web`](../devflow-web/README.md) is what puts those two on a browser channel.

| Method | Behavior |
|---|---|
| `list(filter?, root?)` | One root's cards ordered by id; `filter.stage` narrows to one current location, `filter.parent` to one card's children. |
| `read(id, root?)` | One card with journal-derived state; a missing card throws. |
| `history(id, root?)` | The card's complete decoded journal, oldest first, stream-validated like a read (a structurally invalid journal fails loudly, naming file and line). |
| `holder(id, root?)` | The card's current lease holder (`ClaimHolder`: owner plus last heartbeat), `undefined` while unclaimed; a corrupt claim record fails loudly. |
| `resolveCreate(request)` | Explicit defaulting: turns a caller `CreateRequest` (title, Markdown body, optional slug, actor, optional parent, optional root) into the fully specified `CreateSpec` — the slug derived from the title when omitted, the root resolved, plus the creation timestamp. |
| `create(spec)` | Creates one card: parent validation → sequence-number allocation (continuing past archived cards, so an id is never reissued) → exclusive directory creation → the journal's first `created` entry (the only commit point) → projection write → `devflow/card-created`. Domain rejections resolve `ok: false` with a stable code (`empty-title`, `invalid-slug`, `exists`, `unknown-parent`, `nested-parent`, `parent-settled`); only infrastructure failures reject. |
| `resolve(request)` | Explicit defaulting: turns a caller `TransitionRequest` into the fully specified `TransitionSpec` with its resolved root and commit timestamp. |
| `transition(spec)` | Commits one move: revision CAS → edge check → `devflow/transition` waterfall → journal append (the only commit point) → projection rewrite → `devflow/stage-changed`. Domain rejections resolve `ok: false` with a stable code (`revision-mismatch`, `illegal-edge`, `reason-required`, `vetoed`); only infrastructure failures reject. |
| `claim(id, owner, options?)` | Takes the card's exclusive lease; a held lease resolves with the current holder, unless `options.staleAfterMs` marks its heartbeat lapsed — then the lease is taken over with a journaled `claim-expired` entry. |
| `attachArtifact(request)` | Registers a stage deliverable in the journal against the current stage; rejected while `blocked` or `done`, with the same revision check as `transition`. |
| `archiveDone(root?)` | Moves every archivable `done` card of one root out of the active set into that root's archive, keyed by the month of its last journal entry; a decomposed requirement archives as one family (a done child waits for its parent, then joins the parent's month bucket). Archived cards leave `list` but keep their complete journal. Returns the archived ids in id order. |

Current state always comes from journal replay; a card file's frontmatter is a rebuildable projection. Implementations must fail a read loudly on a structurally invalid journal (naming file and line), warn-and-override on projection drift, and publish state and notifications only after the journal committed. Legal edges (`isLegalTransition`): the pipeline order, rework from `reviewing`/`testing` back to `developing`, `blocked` entry from any non-terminal location, and recovery only to the exact interrupted stage. A rework edge (`isReworkEdge`) without a `reason` is rejected `reason-required`, so the next holder always learns what to fix.

## Stages and journal

`DevStage` is the closed union `draft | designing | ready | developing | reviewing | testing | done`; `blocked` is a bypass location that remembers the stage it interrupted (`CardLocation = DevStage | 'blocked'`). The journal entry union is `created | transition | artifact | claim-expired`, decoded by `decodeJournalEntry` (the durable-boundary validator) and folded by `foldJournal`, which enforces: contiguous revisions from 1, `created` first and only first, transitions departing the current location, and blocked recovery returning exactly to the remembered stage.

A requirement too big for one card becomes a **parent card plus one child card per slice**. The edge is the `created` entry's `parent`, so it is fixed at creation, replayable, and never re-pointed; `foldJournal` surfaces it as `DevCard.parent` and the frontmatter `parent:` is its projection. The breakdown is one level deep — a card carrying `parent` is never itself a parent — and parent and children always share a root. Which cards may take children is the provider's creation-time decision (`unknown-parent`, `nested-parent`, `parent-settled`); the seam holds no rule about how a parent's own stage relates to its children's.

## Events

| Event | Mode | Meaning |
|---|---|---|
| `devflow/transition` | `waterfall` | Single-decision pipeline before the commit, dispatched with the complete `TransitionAttempt` (spec plus departure); a policy listener that owns the decision returns `{ allowed: false, reason }` without calling `next()`. [`dsh-devflow-gates`](../devflow-gates/README.md) runs command policies here. |
| `devflow/card-created` | `emit` | A new card entered the active set: its journal committed the first `created` entry. |
| `devflow/stage-changed` | `emit` | A card settled at a new location after a committed transition. |

The invariant companion validates the emit streams: `card-created` announces only fresh drafts at revision 1 for never-seen ids and never hangs a card under one the stream already knows to be a child, and per card, `stage-changed` revisions strictly increase while every notification reports an actual move.

## Model Experience

Indirectly, through the model-facing tools in dsh-tool-devflow: the service interface itself registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The archive is write-only** — `archiveDone` removes done cards from the active set; no seam operation lists or restores archived cards.
- **No card editing after creation** — `create` fixes the title and body once; changing a card's content remains a direct edit of its `card.md` in the provider's on-disk format.
