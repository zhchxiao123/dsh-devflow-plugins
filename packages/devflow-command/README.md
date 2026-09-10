# @zhchxiao123/dsh-devflow-command

English | [中文](README.zh.md)

Human-facing `/devflow` intervention over the [`ctx.devflow`](../devflow/README.md) task-card seam. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. This is the deterministic plane of the devflow design: the model moves cards through [`dsh-tool-devflow`](../tool-devflow/README.md), the Web header board renders read-only, and `/devflow` covers the interventions that must not depend on a model — inspection, stage moves, lease eviction, and archiving. Every journaled effect carries the actor `{ "kind": "command", "name": "devflow" }`.

## Command contract

| Input | Result |
|---|---|
| `/devflow` | The board: one line per active card — id, location (a blocked card shows its interrupted stage), revision, and title. Children sit indented under the requirement they decompose; a child whose parent left the active set keeps its backlink on its own line. An empty board says so. |
| `/devflow show <id>` | One card: its board line, its parent backlink or its indented breakdown, registered artifacts, the reason it was abandoned when it was, and Markdown body. Reads an archived card too. |
| `/devflow move <id> <stage> [reason]` | One transition through the ordinary executor at the card's current revision. Edge legality, rework `reason` requirements, and the `devflow/transition` gates still decide — the command holds no bypass; a domain rejection returns the seam's message as a direct error. |
| `/devflow takeover <id>` | Forces the lease: any past heartbeat counts as stale, the eviction is journaled as `claim-expired`, and the lease is released immediately, so the evicted holder's next revision-checked commit fails. |
| `/devflow archive` | Sweeps every eligible `done` card into the archive and reports the archived ids. |
| `/devflow archive <id>` | Files one card, with its finished sub-requirements. Each refusal names the next thing to do: a card that is not `done` reports where it is, a slice whose requirement is still open names that requirement, and one already filed points at `/devflow archived`. |
| `/devflow restore <id>` | Brings one archived card back to the board **at the stage its journal already recorded** — restoring returns it to view, not to work, so a card that needs more takes an ordinary rework move. An abandoned card is refused: that decision is terminal. |
| `/devflow archived [<YYYY-MM>]` | The archive, newest bucket first: one line per filed card, tagged `[archived <month>]` or `[abandoned <month>]` because only the first can be restored. A month narrows to one bucket. A page cut short by the store's limit ends with the exact command that continues it. |
| `/devflow archived --cursor <cursor>` | The next page. The cursor is the store's own encoding, passed back whole — this plane neither builds nor parses one. |
| `/devflow spec` | Reports architecture-document health: how many documents are fresh, which are stale or unevaluable **and which anchor failed**, and which expected scopes no document covers. Read-only, and an error rather than an empty report when no document seam is mounted. |

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
  config:
    # Scope roots this workspace expects documents to cover. Only `/devflow
    # spec` reads them, and only to report gaps.
    specScopes: ['@scope/pkg-a', '@scope/pkg-b']
```

`specScopes` is configuration rather than discovery because the seam cannot know what counts as a package here — that is a workspace-layout question, and a guess would report a gap wherever the guess was wrong. Configure nothing and the report says the coverage question was not asked, which is not the same as saying there are no gaps.

`/devflow spec` reads `ctx.devflowSpec` opportunistically and derives the report from the seam's existing read face — the per-document freshness roll-up plus per-anchor verdicts for anything not fresh — so the store gains no method for a report one consumer wants. Its closing line is an instruction rather than a tally: a casualty list that ends without one trains everyone to accept a document set that is quietly decaying.

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
