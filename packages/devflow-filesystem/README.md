# @zhchxiao123/dsh-devflow-filesystem

English | [中文](README.zh.md)

Filesystem Service Provider for the [`ctx.devflow`](../devflow/README.md) seam. Cards live under `<root>/tasks/<id>/` — a directory named `<seq>-<slug>`, stable from creation — as a `card.md` (YAML frontmatter projection plus Markdown body) and an append-only `journal.jsonl`, the authoritative history. One store instance serves any number of roots: every operation resolves its explicit root argument through one defaulting step (an omitted root is the configured default, a given one resolves absolute), per-card serialization keys on root + id, and each returned card names its root.

## Read behavior

`list` scans `<root>/tasks` (a missing root lists empty; entries that are not card directories are skipped), `read` loads one card. Every load replays `journal.jsonl` through the Definition's fold: an invalid JSON line, a malformed entry, or a broken stream fails the read with an error naming the file and line — a card is never silently skipped. The `card.md` frontmatter requires `title`; its `stage`/`stageRevision` fields are projections, warned and overridden by the journal on drift. A card missing its journal fails loudly; a lost `card.md` degrades to a warned journal-only view (the title is frontmatter-owned and irrecoverable) and is rematerialized by the next committed transition.

## Write behavior

`create` serializes in-process and allocates the next sequence number past every active *and archived* card, reserving `tasks/<seq>-<slug>/` with an exclusive (non-recursive) `mkdir`; losing that reservation to another process rescans for a fresh number, and five straight losses resolve the stable `exists` rejection. The journal's first `created` entry is the only commit point — a failed write fails the whole creation — after which the `card.md` projection (frontmatter title, `draft`, revision 1, plus the Markdown body) is written (failure only warns, the standard projection degradation) and `devflow/card-created` is emitted. An omitted slug derives from the title (lowercase alphanumeric runs joined by dashes, bounded, falling back to `card`).

A requested `parent` is validated before any directory is reserved, against the same root: a card the root's `tasks/` does not hold rejects `unknown-parent` unless the root's archive holds it (`parent-settled`, as does a parent already `done`), and a parent that carries a parent of its own rejects `nested-parent` — the breakdown is one level deep. Validation and commit both run under the *parent's* card chain, the same lock its transitions take, so a creation can never interleave with a move deciding on the current children. The accepted edge is written into the `created` entry and projected as the frontmatter's `parent:`; `list` narrows to one parent's children through `filter.parent`.

`transition` serializes per card in-process, then runs revision CAS, edge legality, and the `devflow/transition` waterfall before appending the journal entry — the only commit point; a failed append fails the whole move with nothing published. After the commit the frontmatter projection is rewritten atomically (temp file + rename, preserving unrelated fields and the body; failure only warns) and `devflow/stage-changed` is emitted. `claim` creates `claim.json` with `O_EXCL`: a second claim resolves with the current holder, `heartbeat()` refreshes the liveness mark, and `release()` removes the file idempotently. Cross-process exclusivity relies on the lease, not on the journal append. `archiveDone` renames each archivable `done` card's directory whole into `archive/<YYYY-MM>/<id>/` — the month of its last journal entry, falling back to the current month when that entry's `at` carries no `YYYY-MM` prefix — so the journal and artifacts stay intact while `list` (which scans only `tasks/`) no longer reports the card. A decomposed requirement moves as one family: a done child whose parent is still on the board stays with it, and once the parent is done the whole family lands in the parent's month bucket. A child that outlived its parent's archiving keeps its own month.

## Config

```yaml
- id: devflow
  name: '@zhchxiao123/dsh-devflow-filesystem'
  config:
    root: .devflow
```

| Key | Default | Meaning |
|---|---|---|
| `root` | `.devflow` | Default devflow root, used by operations whose caller derives no root of its own; a relative path resolves against the process cwd. |

## Model Experience

Indirectly, through the model-facing tools in dsh-tool-devflow: the store backend registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Cross-process transition races are not CAS-protected** — the revision check and journal append are two filesystem operations without a file lock, so two *processes* moving the same unclaimed card can interleave; in-process movers are serialized, and the claim lease is the cross-process exclusivity mechanism.
- **Takeover trusts the local clock** — staleness compares the lease heartbeat with `Date.now()`, so severe clock skew across machines sharing one workspace can evict a live holder early or late.
- **Cross-process simultaneous creation can share a sequence number** — the exclusive `mkdir` guards the full `<seq>-<slug>` directory name, so two *processes* creating with different slugs in the same instant can both keep one number; ids stay unique, and in-process creators are serialized.
- **No change watching** — reads are on-demand and [`dsh-devflow-driver`](../devflow-driver/README.md) reacts to in-process `devflow/stage-changed` only; a card moved by another process is seen at the next read, not pushed.
