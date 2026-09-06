# @zhchxiao123/dsh-devflow-guidance

Model guidance for the devflow workflow, in two layers. The [`devflow_*` tools](../devflow-tool/README.md) teach single-call protocol in their descriptions and the gates enforce it; nothing in that surface owns the **cross-tool** process knowledge or answers "does this workspace have a board at all" at the start of a session. This package adds both: the bundled `devflow-workflow` skill (judgment, loaded on demand) and the `devflow-board` runtime context (awareness, resident while a board exists).

Neither layer carries obligations. Per-call protocol (the `stageRevision` optimistic-concurrency token, reading a card before moving it) stays in the tool descriptions, and enforcement stays with the store and the transition policies — a deployment where the model never loads the skill, or that suppresses runtime context, loses guidance, never a guarantee.

## Behavior

**The skill.** `apply` registers one skill provider on `ctx.skills` as an effect of the plugin fiber. The candidate is registered at `BUNDLED_SKILL_RANK` with `{ modelInvocable: true, userInvocable: true }`, so it appears in the model's `<available_skills>` catalog, loads through the `skill` tool, and answers the `/devflow-workflow` user gesture. A deployment overrides the body by registering a same-layer provider under the same name with a lower rank; a nearer-scope provider shadows it regardless of rank. The body ships as `assets/devflow-workflow.md` and deliberately does not enumerate this deployment's required artifact kinds — those differ per deployment and every applicable tool result already carries the artifact-gate preflight, which the skill names as the authority.

**The board snapshot.** An `agent/pre-step` listener (delegate-first; it never takes the step decision) reads the calling session's workspace board — `ctx.devflow.list()` on a workspace without `.devflow/` is one failed readdir with no side effects — plus one `holder()` read per card, renders a snapshot, and caches it by devflow root; a synchronous `ctx.systemPrompt.context()` provider (name `devflow-board`, order 200) serves the cached text for the assembling agent's `session.header.cwd` and contributes `''` without an agent, a cwd, or a board. The harness diffs the joined runtime-context snapshot per step, so an unchanged board is never re-sent. There is deliberately no store-event subscription: the seam emits only on create and transition (abandon, artifact, and archive appends fire nothing), while assembly always follows a pre-step, so the per-step refresh closes that gap and leaves an event listener nothing to add.

The snapshot is capped at 1024 bytes (`SNAPSHOT_MAX_BYTES`): it is awareness, not a board mirror, and every byte is resent whenever any runtime context changes. Over the cap, claimed-card lines are dropped from the end and the drop is announced in the text. Every card-derived line is sanitized so a `{{...}}` pair cannot reach the prompt renderer's strict variable interpolation. Claimed cards render without a "claimed by you" qualifier: the rendered text is cached per workspace root and served to every agent in it, and `list()` carries no lease identity to compare.

## Configuration

None. The skill body is capability prose, not deployment policy; the override path above is the customization surface. The snapshot cap is a documented constant of the awareness contract.

## Model Experience

### Skill catalog entry

#### What the model sees

One `<available_skills>` line while the plugin is mounted (rendering owned by the harness's skill catalog):

> Drive the devflow card workflow: decide when work belongs on the board, pick a service class, decompose an oversized requirement, write artifacts the gates can judge, and choose the rework path after a veto. Use when the user asks to turn a discussed plan or requirement into tracked work, when devflow_transition is vetoed and the next move must be chosen, or when starting work in a workspace that already has an active devflow board.

Loading the skill injects the asset body (about 7 KB) into that step.

### Runtime context

#### What the model sees

While the calling workspace has cards, the runtime-context snapshot carries a `devflow-board` section like:

```
Devflow board: 2 cards (draft 1, designing 1).
Claimed: 2-claimed-work [draft] Claimed work
New requirements start with devflow_create; process knowledge lives in the devflow-workflow skill.
```

A workspace without a board contributes nothing at all.

#### Token effect

One catalog line per request, plus at most 1024 bytes of board snapshot inside the runtime-context message while a board exists. The skill body costs its size only in steps after the model or the user loads it.

#### KV Cache effect

The catalog entry participates in the harness's durable catalog message, republished only when the visible skill set changes. The board snapshot participates in the merged runtime-context snapshot, which the harness re-appends only when any part of it changed — an unchanged board costs nothing, and each board change republishes the merged snapshot once (the cap bounds that price).

## Known Limitations and Deferred Work

- **The skill body is static** — it cannot cite this deployment's configured artifact kinds or gate commands, and points at the tool results' preflight instead. Rendering deployment facts into the body requires a demonstrated need the preflight does not already serve.
- **Claim lines name no holder** — `list()` carries no lease facts, so the refresh pays one `holder()` read per card per step, and the per-root cache cannot attribute a lease to the reading session; a claimed card says "Claimed", not whose.
- **A refresh failure keeps the last snapshot** — a corrupt journal or claim record fails loudly on the tool plane where the model can act on it; the awareness layer logs a warning and serves the previous text rather than failing the model step.
- **Suppressed runtime context drops the snapshot silently** — deployments with `includeRuntimeContext: false` or an active `suppressRuntimeContext()` see the skill but no board awareness; that is the harness's contract, not an error.
