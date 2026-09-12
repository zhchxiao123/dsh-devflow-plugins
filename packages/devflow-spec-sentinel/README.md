# @zhchxiao123/dsh-devflow-spec-sentinel

English | [中文](README.zh.md)

**Turn-end sentinel and pre-step index for devflow spec documents.** The plugin watches which files a turn's first-party `write`/`edit` calls landed; when the stopping turn has left an anchored architecture document stale, it steers the agent into one continuation step that names the document, the failing anchors, and the four legitimate exits — rewrite via `replaces: [<same id>]`, replace a document that was wrong, retire the claim through a merge, or explicitly defer. The same document never interrupts the same session twice; after its one interruption, staleness stays visible through `devflow_read_spec` warnings and the pre-step spec index rather than through force.

This is deliberately the opposite cadence from [`devflow-iron-rules`](../devflow-iron-rules/README.md), whose turn-stopping hook shape it shares without sharing code: an iron rule violation is an **obligation** and blocks every dirty turn until fixed or capped; a stale spec document is a **reference**, and its reader owes it one informed look, not a fight. There is no retry ceiling here because there is nothing to retry — a mid-refactor rename that keeps a document reasonably stale for many turns is a legitimate state, and the sentinel says so in its own message.

Zero configuration is meaningful: without the `devflowSpec` seam the sentinel and the index are inert (both live on a conditional child that follows the seam in and out), and a workspace without spec documents never matches anything.

## What triggers an interruption

- Only files landed by a successful first-party `write`/`edit` count; the paths come from those tools' `file_path` argument, resolved against the calling session's working directory.
- Only `symbol` and `content-hash` anchors participate. A `churn` anchor compares commit time against the document — an uncommitted edit cannot flip it, so churn health belongs to the `/devflow spec` census, and churn anchors never appear in the sentinel's message.
- Only a `stale` verdict arms the sentinel. `unevaluable` means a check can no longer run, which is a census concern, not evidence that this turn's writes broke a claim.
- A `list()`/`evaluate()` failure warns and settles the turn; the awareness layer never fails or wedges a turn.

## The pre-step spec index

Before each model step, the `devflow-spec-map` runtime context lists the documents relevant to what the session has touched — index lines only (id, freshness, and for anchor hits the touched files; never a body), pointing at `devflow_read_spec`. Two layers:

- **Anchor-hit layer** (sharp, writes only): documents whose anchors claim files the session's writes landed. Stale documents come first with their failing anchor ids named — a document whose interruption was deferred stays visible here exactly because it stays stale.
- **Scope layer** (broad, reads included): the other documents of every package the session has touched at all, resolved through the workspace layout below. Reading a file is the early "about to work here" signal.

The touch window is session-cumulative with a fixed recency bound per set; the rendered index is capped at `contextMaxBytes`, dropping scope lines from the end before anchor-hit lines and always announcing the drop. The harness diffs the snapshot per step, so an unchanged index is never re-sent.

## The `devflowSpecWorkspace` service

The plugin publishes an optional read-only service mapping a workspace root to its member packages: `pnpm-workspace.yaml`'s `packages` globs (explicit paths and one-level `dir/*` wildcards, `!` negations; nothing fancier) expanded to directories, each keyed by its `package.json` name — the scope-id prefix its documents live under. A workspace without `pnpm-workspace.yaml` is a single package named by the root `package.json`. Resolution failure warns and yields an empty layout, never an error. Consumers read it with `ctx.get('devflowSpecWorkspace')`; `/devflow spec`'s census uses it to derive scope coverage without configuration.

## Composition notes

- **Beside `devflow-iron-rules`:** when both plugins steer on the same stop, the agent loop merges the messages into a single continuation step, delivered in listener order — nothing is lost or overwritten.
- **Inside `agent/turn-stopping`, this plugin only ever steers or does nothing.** At the pinned harness version, `inject()` during that window feeds the same next-step list as `steer()` and would also hold the turn open; the non-interrupting channel for a deferred document is the pre-step spec index.
- The spec index additionally requires the `systemPrompt` registry; without it, collection and the sentinel still run.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `root` | `.devflow/spec` | Spec root for callers whose session derives no root of its own; a relative path resolves against the process cwd. |
| `contextMaxBytes` | `2048` | Byte ceiling of the rendered spec index; over it, scope lines are dropped from the end first and the drop is announced. |

The spec root of an agent with a session working directory is always `<cwd>/.devflow/spec`, the same derivation every other devflow root uses.
