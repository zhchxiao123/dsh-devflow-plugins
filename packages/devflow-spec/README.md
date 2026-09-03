# @zhchxiao123/dsh-devflow-spec

English | [中文](README.zh.md)

**Service Definition of the `ctx.devflowSpec` capability seam**: architecture documents whose claims are tied to the code they describe by evaluable anchors. This package owns the anchor vocabulary and the structural predicates every write must pass. Storage and anchor evaluation belong to a provider such as `dsh-devflow-spec-filesystem`; the model-facing write tool is `dsh-devflow-spec-tool`.

A document here is not prose that happens to cite code. Every claim rests on a declared anchor, and an anchor that no longer resolves makes the document report itself stale. That is the whole point: a stale architecture document is worse than none, because an agent follows it confidently.

## Service

`DevflowSpecStore` is an abstract Cordis `Service` registered as `ctx.devflowSpec` (one implementation per context; a second registration throws). It is an **optional** service — consumers read it with `ctx.get('devflowSpec')`, never the property proxy, so a deployment without the seam simply has no documents.

| Method | Behavior |
|---|---|
| `list(scope?, root?)` | Index values ordered by id; `scope` narrows by id prefix to one package or face. Each summary carries rolled-up freshness. |
| `read(id, root?)` | One document, its declared anchors, and their verdicts. A reader must be able to learn that what it just read is stale. |
| `evaluate(id, root?)` | The verdicts alone, one per declared anchor in declaration order. |
| `resolveWrite(request)` | Implementation-owned defaults: the spec root when omitted, plus the commit timestamp recorded as `updatedAt`. |
| `write(spec)` | Commit one document: id check, structural checks, anchor evaluation, then the file write. Domain rejections resolve with `ok: false`; only infrastructure failures reject. |

Every declared anchor must evaluate `fresh` at write time — a document may not be born stale.

## Anchors

Three kinds, discriminated by `kind`:

| Kind | Ties a claim to | Goes stale when |
|---|---|---|
| `symbol` | a symbol's continued existence | the symbol is renamed or removed |
| `content-hash` | a symbol's implementation, hashed over its normalized body | a line changes; reformatting does not |
| `churn` | a whole file's last commit | the file was committed after the document's `updatedAt` |

`AnchorVerdict` is **three-valued** — `fresh`, `stale`, `unevaluable` — and the third is reported as itself, never folded into the first. A check that can no longer run is not a check that passed; folding it into a pass is exactly how a permanently-green check appears. `worstFreshness` rolls a document up with `stale` outranking `unevaluable`, because a definite failure survives any number of unknowns.

## Structural contract

`write` refuses a document with a stable code rather than accepting one nothing can check later:

| Code | Cause |
|---|---|
| `invalid-id` | a segment fails `^[@a-z0-9][a-z0-9._@-]*$`; rejection happens at the id, before any path is built |
| `missing-source-of-truth` | no `## Source of truth` section |
| `no-anchors` | a document that anchors nothing; it would report `fresh` forever |
| `duplicate-anchor-id` | two anchors share an id, so citations would be ambiguous |
| `uncited-anchor` | a declared anchor the body never cites as `[[<id>]]` |
| `unknown-anchor` | a citation no declared anchor defines |
| `anchor-unresolvable` | an anchor that does not evaluate `fresh` at write time |
| `exists` | the id is taken |

The citation relation is checked **in both directions**: one half alone lets a document accumulate anchors nothing depends on, or rest claims on anchors that were never declared.

What this contract deliberately does **not** check is whether every substantive claim carries an anchor. That is a natural-language judgement, so it belongs to an LLM admission gate on a transition edge, not to a mechanical structure check. Putting an uncheckable rule in the mechanical layer only produces a check that pretends to be strict.

## Model Experience

Indirectly, through the model-facing tool in `dsh-devflow-spec-tool`: the service interface itself registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No revision replay.** A document's history is the file plus git, not a folded event stream. Spec state stays out of the card journal on purpose, so introducing or removing this seam never changes how any committed card replays.
- **`symbol` and `content-hash` are TypeScript-only.** Files no parser reads can carry `churn` only.
- **No read-side staleness enforcement.** The seam reports freshness; nothing here refuses to serve a stale document. Whether stale reads block work is a deployment's gate configuration.
