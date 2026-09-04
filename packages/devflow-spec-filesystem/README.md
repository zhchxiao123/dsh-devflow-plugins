# @zhchxiao123/dsh-devflow-spec-filesystem

English | [中文](README.zh.md)

**Filesystem Service Provider for the [spec seam](../devflow-spec/README.md)**: architecture documents under `<root>/<id>.md`, with anchors evaluated against the working tree on every read.

## Layout and configuration

```yaml
- name: '@zhchxiao123/dsh-devflow-spec-filesystem'
  config:
    root: .devflow/spec      # documents; relative resolves against cwd
    repoRoot: .              # what the anchors' relative file paths resolve against
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `.devflow/spec` | Default spec root for operations whose caller derives none |
| `repoRoot` | `.` | Repository root the anchor file paths resolve against |
| `maxNetGrowthBytes` | `8192` | Ceiling on one write's NET growth: the new file's size minus everything it replaces. A merge is usually negative and always passes — charging a cluster merge as pure addition would refuse the one move that shrinks the set. It budgets reviewability, not context: bodies never reach a model in bulk, so a large document costs whoever must keep it true. |

The default root sits **inside `.devflow/`**, which `@zhchxiao123/dsh-devflow-fs-guard` already denies file tools by directory-name match. That is not incidental: it makes this store the only write path rather than merely the intended one, without a second guard entry.

A document is frontmatter plus a Markdown body:

```markdown
---
title: Error Handling
description: Domain rejections versus infrastructure failures
updatedAt: 2026-09-02T00:00:00.000Z
anchors:
  - id: a1
    kind: symbol
    file: packages/devflow/src/types.ts
    symbol: CreateRejectionCode
---

## Source of truth

| Anchor | Points at |
|---|---|
| `a1` | `types.ts#CreateRejectionCode` |

The rejection codes are a closed set [[a1]].
```

`updatedAt` is stamped by the store at write time and never read from filesystem mtime — a checkout, copy, or container build resets mtime, and churn anchors compare against this value.

## Anchor evaluation

| Kind | How it is decided |
|---|---|
| `symbol` | the file is parsed and the symbol looked up |
| `content-hash` | the symbol's normalized body is re-hashed and compared |
| `churn` | `git log -1 --format=%cI` on the file, compared against `updatedAt` |

**Normalization drops comments and statement semicolons** and collapses whitespace, so reformatting does not move a hash but an edited line does. Semicolons are dropped deliberately: they are the formatting dimension tools most often disagree on, and a hash that moved when a formatter added them would mark every anchor in the repository stale at once — which trains everyone to ignore the signal. Comments are stripped through the TypeScript scanner rather than a regex, because a regex cannot tell `//` inside a string literal from a comment.

Git is probed once per store. Outside a work tree the evaluator receives no lookup at all, so churn anchors report `unevaluable` — never `fresh`.

## Write path

`write` refuses before touching the filesystem, in this order: id legality, the `Source of truth` section, at least one anchor, the two-way citation relation, then existence, then anchor evaluation. Every declared anchor must evaluate `fresh`; a document may not be born stale. The file is written to a temporary path and renamed, so a failed write leaves no partial document.

Domain rejections resolve with `ok: false` and a stable code. Infrastructure failures — an unreadable path that exists, an unwritable root — reject, because they are not verdicts about the document.

## Model Experience

Indirectly, through `dsh-devflow-spec-tool`: this provider registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No usage index.** Nothing records which cards reached which document, so "nobody has referenced this in months" cannot be answered. Deriving it would mean reading every card's `spec-refs` registration on every query — unbounded in board size, where every other health signal is bounded by document count. The shape it wants is an index maintained at registration time, not a scan at read time.
- **A read still costs one `stat` per anchored file.** The parse cache is keyed on those stats, so an unchanged file is parsed once per store lifetime, but the identity check itself is not cached and is not meant to be: it is what makes an edit visible on the very next read.
- **`symbol` and `content-hash` are TypeScript-only.** Files no parser reads can carry `churn` only; the evaluator reports `unevaluable` for the others rather than passing them.
- **Shell writes bypass the guard.** The fs guard is a policy fence over the tool plane, not a kernel boundary — the same exposure the card journal already has, not one this store introduces.
- **Anchors are re-evaluated per read, cheaply.** Verdicts themselves are never cached — only the parse behind them — so a read always reports the tree as it stands rather than as it stood.
