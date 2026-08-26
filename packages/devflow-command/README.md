# @zhchxiao123/dsh-devflow-command

English | [中文](README.zh.md)

Human-facing `/devflow` intervention over the [`ctx.devflow`](../devflow/README.md) task-card seam. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. This is the deterministic plane of the devflow design: the model moves cards through [`dsh-tool-devflow`](../tool-devflow/README.md), the Web header board renders read-only, and `/devflow` covers the interventions that must not depend on a model — inspection, stage moves, lease eviction, and archiving. Every journaled effect carries the actor `{ "kind": "command", "name": "devflow" }`.

## Command contract

| Input | Result |
|---|---|
| `/devflow` | The board: one line per active card — id, location (a blocked card shows its interrupted stage), revision, and title. Children sit indented under the requirement they decompose; a child whose parent left the active set keeps its backlink on its own line. An empty board says so. |
| `/devflow show <id>` | One card: its board line, its parent backlink or its indented breakdown, registered artifacts, and Markdown body. |
| `/devflow move <id> <stage> [reason]` | One transition through the ordinary executor at the card's current revision. Edge legality, rework `reason` requirements, and the `devflow/transition` gates still decide — the command holds no bypass; a domain rejection returns the seam's message as a direct error. |
| `/devflow takeover <id>` | Forces the lease: any past heartbeat counts as stale, the eviction is journaled as `claim-expired`, and the lease is released immediately, so the evicted holder's next revision-checked commit fails. |
| `/devflow archive` | Moves every `done` card into the archive and reports the archived ids. |

An unknown sub-command, a malformed argument list, or a target that is neither a stage nor `blocked` returns a direct usage error before touching the store.

Every sub-command operates on the invoking session's workspace root: a session whose header carries a `cwd` reads and writes `<cwd>/.devflow`, and a session without one uses the store's configured default root — so `/devflow` and the model tools of the same session always see the same board.

## Composition

The producer injects `commands` and `devflow`. A custom app mounts their owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: devflow
  name: '@zhchxiao123/dsh-devflow-filesystem'
- id: command-devflow
  name: '@zhchxiao123/dsh-devflow-command'
```

## Model Experience

### Human `/devflow` intervention

#### What the model sees

Nothing directly: the slash input and its direct output are absent from model requests. A committed intervention lands in the card journal, so a model that later reads the board through the `dsh-tool-devflow` tools sees the new location and the `command devflow` actor like any other journal history.

#### Token effect

None. Board and card output is direct command text; later devflow tool reads bill as those tools' results.

#### KV Cache effect

None; command discovery, execution, and output never enter a provider request.

## Known Limitations and Deferred Work

- **No card creation or editing** — the command intervenes on existing cards; authoring `card.md` and its journal stays outside the seam.
- **Takeover trusts heartbeat timestamps** — staleness is a strict age comparison, so a heartbeat written in the same millisecond or carrying a future timestamp still counts as live and the takeover reports the holder instead.
- **Command adapters ship only in the Web client** — the headless, ACP automation, and JSON-RPC apps do not consume `ctx.commands`; there, interventions go through the model tools or directly on disk.
