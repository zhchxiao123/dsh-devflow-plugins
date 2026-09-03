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

- **No evaluation cache.** Every read re-parses the anchored files. The cache shape is designed (keyed on the anchored file's size and mtime, mirroring `dsh-devflow-agent-gate`'s verdict cache, with failures never cached) but not built: there is no consumer at a scale that needs it yet, and this line does not carry surface nothing reads.
- **`symbol` and `content-hash` are TypeScript-only.** Files no parser reads can carry `churn` only; the evaluator reports `unevaluable` for the others rather than passing them.
- **Shell writes bypass the guard.** The fs guard is a policy fence over the tool plane, not a kernel boundary — the same exposure the card journal already has, not one this store introduces.
- **Create only.** Revising or replacing an existing document is not this operation; `exists` refuses.
