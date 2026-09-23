# Codex adapter versus DSH Devflow

This is an implementation inventory, not a claim that the two runtimes are equivalent. DSH is a composition of independent Harness services; the Codex plugin is a local MCP server with a bundled skill and a browser board.

| DSH capability | Codex adapter | Remaining work |
|---|---|---|
| Project-scoped task journals; create, list, show | Implemented | Original provider's recovery/compaction behavior is not copied. |
| Artifact registration and latest-kind read | Implemented | Full YAML structural parsing and artifact inspection output are missing. |
| Stage graph, revisions, block/rework and parent completion | Implemented | Native Harness waterfall event dispatch is not available. |
| Artifact, command, agent admission gates | Implemented locally | The agent gate starts a separate read-only Codex CLI, not a native child of the current chat. |
| Human approval on a transition | Optional MCP form elicitation | Requires a client that supports forms and is configured for user review. MCP provides no human identity attestation; the operator must enable the explicit trust setting. |
| Archive, restore, abandon; archived listing | Local command and read-only MCP list | Archive migration recovery and a native human action surface need work. |
| Lease ownership, heartbeats and takeover | Missing | Requires a durable session identity and handle lifecycle across calls. |
| `ocr` delegate code review gate | Missing; fails closed if configured | Requires `ocr` CLI integration, complete diff/rule accounting and report tests. |
| Mechanical validators, including Midscene | Missing; fails closed if configured | Requires provider protocol, acceptance evidence, timeout and revalidation. |
| Architecture Spec store, anchors and sentinel | Missing | Requires language evaluators and Codex hook integration. |
| Worktree enforcement and filesystem write guard | Missing | Requires trusted Codex hook installation and coverage of write tools. |
| Scheduler, GitHub intake, business memory, deploy | Missing | These are separate DSH packages with their own storage, credentials and integration settings. |
| Kanban | Local read-only browser view | No persistent native Codex sidebar registration interface is exposed to this plugin. |

The bundled DSH policy enables the artifact and independent agent checks configured in the supplied profile. It does not silently enable the unrelated optional packages listed above. Project policies can add a supported gate; unsupported declarations fail closed.
