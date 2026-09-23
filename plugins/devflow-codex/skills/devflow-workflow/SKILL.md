---
name: devflow-workflow
description: Inspect a Devflow board and track development requirements as durable cards. Use when a project has .devflow or the user asks to track work in Devflow.
---

# Devflow workflow

Use the Devflow MCP tools to inspect and create cards. Pass `projectRoot` as the absolute path of the project currently being worked on with **every** tool call. Verify it from the current project context; do not guess from the plugin's installation directory or reuse a path from a different project. The store uses `<projectRoot>/.devflow`. If the current project is unclear, request its path before creating a card. An explicitly configured `DEVFLOW_ROOT` can serve as the single-project default when no projectRoot is given. Read a card before attaching an artifact or proposing a stage change. The revision returned by a read is required by every write; read again if a write reports a mismatch. Do not write `.devflow/` files directly.

When the user asks to see the Kanban board, call `devflow_board_open` with the current projectRoot and provide its local URL. The user can open the URL in the Codex in-app browser pane; it shows that project's path and cards and refreshes automatically. It is a read-only view, and the Codex plugin cannot register a permanent native sidebar tab.

Use `devflow_archived` to inspect settled cards, and `devflow_show` to read their current state and registered artifacts. Human lifecycle actions are available through the bundled `devflow-cli.mjs` in a local terminal. Do not use the shell command entry point to change a card on the user's behalf unless they explicitly request that action.

Before a move requiring independent review, you may delegate a read-only pre-review to a native Codex subagent and address its findings. The plugin itself also enforces its configured gates when `devflow_transition` is called: the independent checker is a separate read-only Codex CLI run because an MCP service cannot spawn and attest a native child of the invoking chat. Do not claim the native subagent's advice is an authoritative gate verdict. If a gate fails, correct the artifact or configuration and retry at the current revision; do not bypass the gate by writing the journal directly. For detailed process guidance, read [reference.md](reference.md).
