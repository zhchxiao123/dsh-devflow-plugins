# Codex lifecycle and interactive approvals

## User need

The Codex adapter must carry more of DSH Devflow than card creation and gated transitions. In particular, a delivered card must be fileable and restorable, a withdrawn card needs a terminal reason, and optional approval gates need a host interaction instead of an agent-supplied boolean.

## Implemented

The standalone store now reads archived cards, lists archive buckets, and commits the same `archived`, `restored` and `abandoned` journal variants as the DSH seam. Archive and abandonment move card directories only after append, and finished children are filed with the parent. `devflow-cli.mjs` is the local user-facing entry point; the MCP mutation tools do not expose these decisions. The MCP adapter exposes read-only `devflow_archived`, and the browser channel exposes a corresponding JSON route.

An approval edge asks the MCP client through `elicitation/create` after the other configured checks pass. The stdin loop remains active while the tool call waits for the client reply. Unsupported clients, decline, timeout and error veto without a journal commit. MCP replies do not attest a human identity, so the server also requires an explicit operator trust setting and otherwise fails closed. This is an integration assumption rather than cryptographic proof of a human actor.

## Boundaries

The Codex plugin still does not provide DSH's lease service, `ocr` group review, provider-based validators, spec anchors and sentinel, automation service stack, deployment, or an in-app permanent sidebar. They require separate implementations or additional host capabilities, and are tracked in `plugins/devflow-codex/CAPABILITY_MATRIX.md`. A shell-capable model can invoke the local CLI; this package does not implement an OS-level identity boundary for lifecycle operations.
