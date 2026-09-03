# @zhchxiao123/dsh-devflow-spec-tool

English | [中文](README.zh.md)

**The model-facing half of the [spec seam](../devflow-spec/README.md)**: `devflow_write_spec` commits one architecture document. A thin Consumer over `ctx.devflowSpec` — id legality, the structural contract, and anchor evaluation all live behind the seam, so a refusal here carries the seam's own stable code.

## Contract

`devflow_write_spec({ id, title, description?, body, anchors })` creates one document and returns its id, path, and anchor count.

- `id` is a slash-joined scope path (`@scope/package/backend/error-handling`); each segment must match `^[@a-z0-9][a-z0-9._@-]*$`, and rejection happens at the id before any path is built.
- `body` must carry a `## Source of truth` section and must cite every declared anchor as `[[id]]`.
- `anchors` must hold at least one entry. `symbol` and `content-hash` anchors also carry `symbol`. A `content-hash` anchor normally **omits** `hash`: no caller outside this line can compute a digest over a parser-normalized body, so the store records the anchored symbol's current one. A symbol that cannot be found leaves it unresolvable and the write is refused.

Every declared anchor must evaluate `fresh` at write time — a document may not be born stale. Rejections surface as tool errors prefixed with the seam's code: `invalid-id`, `missing-source-of-truth`, `no-anchors`, `duplicate-anchor-id`, `uncited-anchor`, `unknown-anchor`, `anchor-unresolvable`, `exists`.

The tool requires an owning agent session; a caller without one is refused before any side effect.

**This is the only way a document reaches disk**, and that is enforced rather than intended: the spec root sits under `.devflow/`, which [`dsh-devflow-fs-guard`](../devflow-fs-guard/README.md) denies the file tools.

## Rendering intent

An `edit`-kind `generic` card whose `rawInput` is the document title. The presenter is a pure function of the arguments.

## Model Experience

### Tool schema

#### What the model sees

One tool. Its description states the anchor discipline — that anchors are what make a document self-invalidating, and that readers are told a document is stale rather than following it — because a model that treats anchors as bookkeeping will write documents that pass the structural contract and protect nothing.

#### Token effect

A fixed schema cost while the plugin is active; results are three short fields.

#### KV Cache effect

Prefix-stable while the plugin scope is unchanged; activating or unloading may invalidate reuse from the tool-schema section onward.

## Authoring skill

The package ships [`skills/dsh-write-spec`](skills/dsh-write-spec/SKILL.md): how to choose what a document should claim, which anchor kind catches the change you actually fear, and when a claim does not deserve a document at all. Read it before writing the first document for a package — the structural contract cannot tell a well-anchored document from a document that anchors whatever was easy.

## Known Limitations and Deferred Work

- **Create only.** Revising or replacing an existing document is not this operation; `exists` refuses. Revision with its net-change budget belongs to a later change.
- **No read tool.** Reading a document back through the model plane is not part of this package yet; the seam's read face exists and has no model-facing consumer.
- **A supplied `hash` is trusted to be about the anchored symbol.** Omitting it is the normal path and the store computes the right digest; a caller that supplies one derived from something else gets a document that is fresh by construction and meaningless.
