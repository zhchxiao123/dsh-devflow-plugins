# @zhchxiao123/dsh-devflow-tool

English | [中文](README.zh.md)

The model-facing devflow tools: **`devflow_list`** surveys the workspace task board, **`devflow_show`** reads one card, **`devflow_create`** turns a chat-agreed requirement into a new draft card, **`devflow_take`** claims a ready card into development, **`devflow_transition`** commits one stage move, **`devflow_attach_artifact`** registers a stage deliverable, and **`devflow_read_artifact`** reads one kind's newest registration back. All are thin Consumers over [`ctx.devflow`](../devflow/README.md); journal replay, edge legality, and rejection semantics live behind the seam, so a structurally invalid journal surfaces as a tool error naming the file and line. Every tool operates on the calling session's workspace: an agent whose session header carries a `cwd` reads and writes `<cwd>/.devflow`, and a caller without one uses the store's configured default root — sessions in different workspaces see different boards from the same host.

## Contract

`devflow_list({ stage?, parent? })` returns `{ cards }` — id, title, current stage, `stageRevision`, and the optional `parent` per card, ordered by id; `stage` narrows to one location (a pipeline stage or `blocked`) and `parent` to one requirement's breakdown. It stays compact and directs a model to show a selected card before moving it. `devflow_show({ id })` returns the card's title, stage, `stageRevision`, optional `blockedFrom`, its `parent` with that card's `parentTitle`, its `children` summaries, the card-file path, registered artifacts, the optional current artifact-gate preflight, and full Markdown body — so a model holding only a child card can read the requirement it decomposes, a model holding a parent sees the whole breakdown, and neither has to attempt a transition to discover a deliverable contract. `devflow_read_artifact({ id, kind })` returns that kind's newest registration — path, revision, registering stage, and content; a card without one errors with the stable `no-artifact` message.

When `dsh-devflow-artifact-gate` is mounted and the current stage has a configured legal outgoing contract, `devflow_create`, `devflow_show`, successful `devflow_transition`, successful `devflow_take`, and `devflow_attach_artifact` include `artifactGates`: the edge plus every required kind's `missing | malformed | satisfied` status, structure template, newest registration, and defects. Create also renders the initial `stageRevision`, so the model can attach the first required artifact without an extra read. Create and successful moves therefore announce the destination stage's work immediately; attachment immediately reports malformed content without rolling back its immutable journal registration. Without an applicable contract the optional field and its rendered text are omitted.

The mutations require an owning agent session (a non-agent caller is rejected before any effect). `devflow_create({ title, body, slug?, parent? })` creates one card at `draft` with a fresh sequence number — the body carries the requirement and its acceptance criteria, an omitted slug derives from the title, and `parent` hangs the card under the bigger requirement it decomposes; an empty title, ill-formed slug, lost sequence race, or illegal parent (unknown, already a child, or settled) returns a tool error carrying the seam's stable message. `devflow_transition({ id, to, expectedRevision, reason? })` resolves and commits one move; a stale revision, illegal edge, missing rework reason, or policy veto returns a tool error carrying the seam's stable message. `devflow_take({ id, expectedRevision })` claims the card's exclusive lease and moves it `ready -> developing`; a failed move releases the lease before the rejection reaches the model, so a failed take has no side effects. `devflow_attach_artifact({ id, expectedRevision, ... })` records a stage deliverable in the card history against the current stage, in one of two forms the tool refuses to mix: `path` registers a file the caller already wrote under the card directory, while `kind` plus `content` has the store write `artifacts/<rev>-<kind>.md` itself; registrations are immutable, so re-registering a kind writes a new revision-named file and readers take the newest. The card's `.devflow` journal is the authority for every move, and the calling agent's session log already carries each call and its result as `tool/call` and `tool/result`; these tools append no devflow-shaped session event of their own.

## Render intent

Reads are `generic` cards of kind `read`; mutations are `generic` cards of kind `edit` carrying the salient arguments as `rawInput`. Presenters are pure functions of arguments.

## Model Experience

### Tool schemas

#### What the model sees

The generated [`devflow_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-devflow): two reads, the card creation, and three revision-checked mutations whose descriptions carry the stage pipeline (`draft, designing, ready, developing, reviewing, testing, done` plus the `blocked` bypass), the parent/child breakdown of a requirement too big for one card, the optimistic-concurrency contract, and result fields as declared output schemas. Applicable single-card results also carry the artifact preflight and render an explicit stop instruction while any requirement is unsatisfied.

#### Token effect

Fixed schema cost per request while the plugin is active; results are proportional to the listed cards or the shown card body.

#### KV Cache effect

Prefix-stable while the plugin scope is unchanged; activation or disposal may invalidate reuse from the tool-schema section onward.

## Known Limitations and Deferred Work

- **No editor follow-along locations** — presenters are pure functions of call arguments and the card path is provider deployment state, so `presentCall` cannot name the card file; the show result carries `path` instead.
- **A taken lease is never heartbeated by the tool** — `devflow_take` claims but holds no background heartbeat; `/devflow takeover` is the explicit recovery plane for an abandoned owner.
