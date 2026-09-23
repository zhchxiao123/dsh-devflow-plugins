# Agent Note: Codex adapter keeps journal replay shared and stage writes gated

Status: implemented

## Problem

The Devflow card model and filesystem provider currently run inside DeepSeek Harness. A Codex plugin cannot load the Harness tool registry or transition waterfall by declaring a plugin manifest. Copying the workflow instructions alone would let an agent claim progress without committing a checked card transition.

## Decision

`plugins/devflow-codex` introduces a self-contained local stdio MCP entry point. It bundles exact snapshots of the Definition's `journal.ts`, `stages.ts`, and `types.ts` and tests that these copies match their owners. The adapter reads existing `.devflow/tasks` journals through the same decoder and fold used by the Harness provider. Card creation and artifact registration use the existing journal event vocabulary and the same per-card `commit.lock` path. Every MCP call names an absolute `projectRoot`, canonicalized before it selects `<projectRoot>/.devflow`. The explicit `DEVFLOW_ROOT` is a single-project fallback. The MCP process cwd is never treated as the active project.

Stage transitions now load the bundled strict DSH policy, with an optional full project override in `.codex/devflow-policy.json`. A local evaluator runs artifact and command checks, plus the parent completion check, before committing gate verdicts to the journal. For configured agent review it starts an independent read-only `codex exec`, supplies the card and registered inputs, requires a structured verdict and writes a report; identical inputs reuse a cached verdict. It cannot dispatch a native subagent of the invoking chat through the MCP server. This local implementation does not dispatch Harness `devflow/transition` listeners; approval, code review and external validator requirements still refuse the move. A missing edge also refuses it. The old `DEVFLOW_ALLOW_UNGATED_TRANSITIONS` flag no longer bypasses checks. The model-side skill instructs agents not to edit protected journals as a workaround.

The plugin is a local implementation slice. It does not claim equivalents of the human command surface, project board, spec documents, automation, lease handling, or remote ChatGPT connection. Those capabilities need service implementations that share the same journal authority.

## Alternatives considered

**Load the Harness plugin bundle unchanged.** Its Cordis context, tool registry and UI slots require a Harness host. Packaging the bundle as an MCP server without its host would expose none of those surfaces.

**Implement the full transition pipeline in the prompt.** Guidance can be skipped and cannot enforce revision checks or approval attribution. The adapter refuses ungated transitions until a server-side policy chain exists.

**Vendor the whole filesystem provider.** It depends on Cordis for its service and transition events. The first slice keeps the durable format and replay logic while the host-independent service boundary is established.

## Consequences

Codex can inspect existing cards and append new draft cards and artifacts with a tested stdio protocol. The journal decoder remains identical to the repository owner, and the snapshot test exposes drift. The implementation uses Node.js 24 type stripping and has no npm installation step. Calls need a project path unless the process was deliberately configured for one project. Full Devflow behavior remains unavailable until the independent policy and human-action surfaces are migrated.
