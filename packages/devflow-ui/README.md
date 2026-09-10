# @zhchxiao123/dsh-devflow-ui

English | [中文](README.zh.md)

The browser half of the Devflow board. It integrates directly with the official right Sidebar shipped by DeepSeek Harness `0.1.3-alpha.2`: the plugin registers a `devflow` tab type through `ctx.sidebarRightTabs` and mounts its body in the keyed `sidebar.right.pane.tab` slot. No extra sidebar plugin or floating fallback is required.

The page is a full-height, stage-centric Kanban. Its wide view has the seven ordered `DevStage` columns; each header reports the number of leaf work items in that stage. `blocked` remains a bypass rather than an eighth column: a blocked card stays in its `blockedFrom` column with warning treatment, while malformed data without an origin remains reachable in a fallback group. A top-level requirement with children becomes a collapsible swimlane, and each child appears exactly once in its actual stage. Standalone cards and children whose parent has left the active set share an independent-work lane. Completed cards are visually quiet and capped until expanded. A compact list remains available from the view switch. Narrow panes expose a stage selector instead of crushing all seven columns together.

The toolbar reports total, in-progress, blocked, and completed counts, and — in the list view — offers a control that shows the archive. Archived cards render as a secondary read-only group after the board, each tagged by how it left, because only a filed card can come back and that is a `/devflow` decision. The archive is fetched when a reader asks for it and not on every mount: the set is unbounded and secondary to the board. Its pages accumulate behind a "load more" control, and a change frame restarts them rather than resuming, because a card filed or restored between two pages shifts the set the cursor was issued against. The Kanban view holds no archived cards at all — they would swell its done column with work nobody is doing. Loading, a settled empty board, and a failed first read are distinct states; failures offer retry, while a failed background refresh preserves the last successful board. Opening a card shows its requirement, breakdown, artifacts, holder, named pipeline, and newest-first journal timeline. Sections arrive open and can be folded. In the Sidebar's normal presentation, detail replaces the board and offers a back action; in the official fullscreen presentation, board and detail sit side by side.

Every tab reads the workspace belonging to its own session-scoped slot. A binding is created per session and begins fetching only while that tab body is visible. Change frames refetch visible bindings, so hidden tabs do not create background board traffic. The read-only JSON face and `/devflow/ws` change stream are served by [`@zhchxiao123/dsh-devflow-web`](../devflow-web/README.md) on the same origin as the app.

The plugin issues no mutations. Card moves belong to the model-facing Devflow tools and the `/devflow` intervention plane; human approvals continue through Harness's approval composer.

## Runtime contract

Harness currently composes the official Sidebar implementation in its Web bundle, but does not yet publish `@deepseek-ai/dsh-client-ui-sidebar-right` as an npm package. To keep this standalone plugin installable, `sidebar-right.ts` restates only the public registry and slot types it consumes. Runtime behavior still comes entirely from Harness. Component tests cover this plugin's registration and keyed body behavior against that restatement; they do not replace a real host-composition test. The packed plugin has therefore also been exercised in a real Harness `0.1.3-alpha.2` Web profile. A portable automated host-composition fixture remains a release exception until the official package is published or otherwise made available to this repository.

## Model Experience

None. This package renders fetched board state for a human and does not touch prompts, messages, schemas, streams, or tool results. The model's view of the same cards belongs to [`@zhchxiao123/dsh-devflow-tool`](../devflow-tool/README.md).

#### KV Cache effect

None; this package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Read-only by design** — semantic moves stay in chat tools and operational intervention stays in `/devflow`.
- **No WIP limits or inferred stage age** — the listing does not carry workflow limits or stage-entry time, so the board reports placement and counts without inventing metrics.
- **Whole-board refetch per change frame** — incremental frames can wait until board sizes justify the added protocol complexity.
- **Breakdown markers only see currently blocked children** — showing rework history on parent cards would require every child's journal.
- **Collapse and view-mode state is per mount** — these are local viewing preferences and reset when the page remounts.
- **The official Sidebar package is not yet published independently** — installation therefore targets a Harness Web profile that already composes the service and slot. The plugin intentionally does not fall back to a second navigation system.
