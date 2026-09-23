# Devflow Codex adapter (initial implementation)

This self-contained local plugin reuses snapshots of the repository's `journal.ts` and `stages.ts` under `runtime/` for validation and replay. It runs on Node.js 24 or newer. Each MCP call supplies the absolute `projectRoot` for the current project; the store uses `<projectRoot>/.devflow` and canonicalizes the project path. One MCP process can serve multiple projects without sharing their card directories. The plugin never infers a project from the MCP process working directory, which is not guaranteed to be the active Codex project. `DEVFLOW_ROOT` remains an explicit single-project fallback for older calls that lack projectRoot; set it only to an absolute `.devflow` directory.

The MCP tools support `devflow_list`, `devflow_archived`, `devflow_show` (including archived cards), `devflow_create`, `devflow_attach_artifact`, `devflow_read_artifact`, and `devflow_transition`. Stage moves use the bundled DSH policy in `examples/devflow-policy.from-dsh.strict.json` by default; an optional `<projectRoot>/.codex/devflow-policy.json` replaces it for that project. The adapter validates revision and legal edge, then runs configured artifact structure and command checks plus the parent completion check before appending a transition with gate verdicts. A missing edge or malformed project policy rejects the move. Review project policy changes as carefully as changes to build scripts. The old `DEVFLOW_ALLOW_UNGATED_TRANSITIONS` environment variable has no effect.

The full example covering standard, express and emergency transitions is in `examples/devflow-policy.json`; copy it to `<projectRoot>/.codex/devflow-policy.json` and adjust the artifact kinds, headings and optional commands for your workflow. A shorter policy (declare each edge your project uses):

For the supplied DSH `cordis.patch.yml.2`, the bundled strict policy retains the five artifact kinds, required frontmatter fields and section names, including both required kinds on `designing->ready`. It also carries the original five independent checker prompts, their input kinds and 600-second timeout. For those edges, the adapter starts an ephemeral `codex exec` with a read-only sandbox, requires a structured allow/veto result, records a report, and caches verdicts by the exact inputs. The `codex` binary must be available to the MCP process on `PATH`, or be set as an absolute `DEVFLOW_CODEX_BIN`; its CLI authentication must be available. Missing CLI, authentication errors, timeouts, malformed replies and vetoes refuse the move. A Codex client can independently spawn its native subagents based on the skill's instructions, but the MCP server cannot request a native child of the invoking chat or verify a chat-level reply as a policy verdict. To explicitly opt into reduced mechanical checks, copy `examples/devflow-policy.from-dsh.mechanical-only.json` to `<projectRoot>/.codex/devflow-policy.json`. The DSH patch's `testenv`, deploy, scheduler, GitHub sync, automation, business, Midscene and jev entries configure other Harness services; they do not belong in the stage policy. The local frontmatter check requires a non-empty `key: value` line; it does not parse and validate YAML as the Harness artifact gate does.

```json
{
  "version": 1,
  "kinds": { "analysis": { "sections": ["Scope"], "nonEmptySections": ["Scope"] } },
  "edges": {
    "draft->designing": { "artifacts": ["analysis"], "commands": ["npm test"] },
    "designing->ready": { "artifacts": [] }
  }
}
```

This is a local policy implementation, not the Harness `devflow/transition` event dispatcher. Approval edges use MCP form elicitation only when the client advertises it and the operator has set `DEVFLOW_TRUST_MCP_ELICITATION_HUMAN=1` after configuring the client to route these requests to a human reviewer. An elicitation reply carries no identity attestation; without that operator assertion the edge fails closed. Declined, unsupported, and timed-out requests also veto. Code review and external validators are not integrated: edges declaring `codeReview` or nonempty `validators` fail closed. The independent reviewer uses a separate CLI invocation, not the active conversation's native subagent mechanism. Card creation and artifact registration write the same journal vocabulary and directory layout as the Harness provider. Leases, spec, automation, and the Harness-native UI remain to be ported.

Human lifecycle operations use the bundled command line entry point, not model-facing MCP mutations:

```sh
node /path/to/devflow-codex/devflow-cli.mjs --project /absolute/project archived
node /path/to/devflow-codex/devflow-cli.mjs --project /absolute/project archive 0001-example 7
node /path/to/devflow-codex/devflow-cli.mjs --project /absolute/project restore 0001-example 8
node /path/to/devflow-codex/devflow-cli.mjs --project /absolute/project abandon 0002-old 3 "no longer needed"
```

Archive commits to the journal before moving the card to `archive/<YYYY-MM>/`, cascades to finished children, and can be reversed. Abandonment requires a reason and is terminal. This local command is not an authenticated human identity boundary: a process with shell access to the user's files can also run it. Use it only on a trusted local machine.

`devflow_board_open({ projectRoot })` starts a local read-only Kanban server bound to `127.0.0.1` on a random port, returns its URL, and keeps it alive while the MCP process is running. Each distinct project has its own board URL. Open the URL in Codex's in-app browser to use the right-hand browser pane. The seven columns, blocked markers, search, card details, artifact registrations, and five-second refresh read the same `.devflow/` directory as the MCP tools. The board is not a permanent native sidebar extension and is not accessible from a remote Codex session.

After upgrading from the original prototype, check where earlier cards were created. The old adapter used the MCP process `cwd`, which could be the plugin cache or application directory. It is safe to inspect that old `.devflow` directory before moving any data into the intended project; do not merge journals blindly if either location already has cards with the same ids.

Run a local smoke test with `node --test plugins/devflow-codex/tests/*.test.mjs`. The original Harness package suite requires dependencies installed via pnpm and is a separate gate.

The package has no remote HTTP MCP endpoint, so it is usable only by a client that launches local stdio servers. ChatGPT cloud needs a separately authenticated service with project-scoped filesystem access.

See [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) for the current migration inventory and the remaining Harness-specific work.
