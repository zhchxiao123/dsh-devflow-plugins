# @zhchxiao123/dsh-devflow-driver

English | [中文](README.zh.md)

Stage driver for the [`ctx.devflow`](../devflow/README.md) seam: a pure Consumer that turns committed `devflow/stage-changed` moves into one-shot subagent dispatches. Each configured stage names a subagent provider and optional instructions; a card waits if that provider has not registered yet, so independently mounted provider plugins may activate in either order. Before each dispatch the driver reads the current deployment route from `ctx.agentDefaultModel` and supplies its provider and model as the child's `agentOptions`; a per-card-root parent supplies the corresponding workspace `cwd`. The driver claims the card's lease (taking over stale ones with a journaled `claim-expired` entry), starts one child whose objective is the card, heartbeats the lease at a third of the staleness window while the child runs, and parks the card `blocked` when the child fails or cannot start. Claims, reads, and parking moves all follow the moved card's own `root`, so a multi-workspace host never crosses one workspace's card with another's directory. The child advances the card itself through the devflow tools — the driver never moves a card forward.

## Behavior

On activation the driver waits for the required default-model service and sweeps the board once so cards already sitting at driven stages dispatch without waiting for the next move (a failed sweep only warns; the listener keeps driving). A card whose configured provider is absent stays pending; the first wait for each provider logs at `debug`, and `subagent/provider-added` releases every matching card into the ordinary queue. Dispatches queue in arrival order under `maxConcurrentCards`; each one snapshots `ctx.agentDefaultModel.currentSelection()` into the child request, so later dispatches follow later deployment-model changes. A card whose lease is freshly held by another worker is skipped, and an engaged card is never double-dispatched. A card that decomposes into child cards is skipped too — its children carry the executable work, so a requirement never becomes one child's objective; a board that cannot be listed at all skips as well, because dispatching a possibly-parent card is the worse failure. A `stage-changed` whose revision moved backwards (a branch switch replaying older state) triggers a quiet rescan of that card's root; if its child is still engaged, re-entry waits until the child exits instead of being dropped as a duplicate. Children of a disposed driver are aborted through the start signal, held leases release, and no further dispatches run.

A stage may also name artifact `inputs` and a `produces` kind. Each dispatch inlines the newest registration of every input kind into the child prompt between the card body and the closing contract, under one `--- artifact <kind> (rev N) ---` separator per artifact; a kind with no registration skips silently, because the first round of a rework loop has no review yet, and the second round of that loop reads the same card fresh, so it feeds the newer revision. Feeding is best-effort — the opposite of the [artifact gate's](../devflow-artifact-gate/README.md) fail-closed check: an unreadable registered file warns and skips that one artifact instead of blocking the dispatch, because the child can still work the card from its body while a refused dispatch would stall the board over missing prompt context — and the gate still stops the card's next move until the disk serves the file. A `produces` kind appends the instruction to register the deliverable through `devflow_attach_artifact`'s kind + content form; when the optional `devflowArtifactSpecs` service declares structure for that kind, the instruction carries a template skeleton of the required frontmatter fields and `## ` sections, so the producer shapes the file to the same spec the gate checks. Without the service — or for a kind declared without structure — the child is still told what kind to register, just not what shape it takes. Dispatches in one card root share a synthetic, never-prompted parent agent (`devflow-driver-<pid>-<n>`) whose session `cwd` is the parent directory of that root. Separate roots receive separate parents, so child workspace inheritance follows the card.

## Config

```yaml
- id: devflow-driver
  name: '@zhchxiao123/dsh-devflow-driver'
  config:
    stages:
      designing:
        provider: spawn
        produces: design
      ready:
        provider: spawn
        instructions: Take the card into development.
        inputs: [design, review]
    maxConcurrentCards: 2
    claimStaleAfterMs: 300000
```

| Key | Default | Meaning |
|---|---|---|
| `stages` | `{}` | Dispatch per entered stage; `done` and `blocked` cannot be driven. |
| `stages.<stage>.inputs` | none | Artifact kinds whose newest registration is inlined into the child prompt, best-effort. |
| `stages.<stage>.produces` | none | Deliverable kind the child is instructed to register, templated when its spec is published. |
| `maxConcurrentCards` | required | Cap on concurrently driven cards; further cards queue. |
| `claimStaleAfterMs` | `300000` | Lease heartbeats older than this are taken over. |

An undrivable stage name, a non-positive cap, or an `inputs`/`produces` kind outside the seam's kind grammar (lowercase letters, digits, and dashes, starting alphanumeric) fails the load. Provider availability is runtime lifecycle state: an absent provider leaves matching cards pending until it registers.

The child model route is not duplicated in this config. The driver requires the harness's `agentDefaultModel` service and reads its current provider/model pair for every dispatch.

## Model Experience

### Child objective prompt

#### What the model sees

Each dispatched child's user message is the configured stage `instructions` (when present), the line `You are driving devflow task card <id> at stage "<stage>" (revision <n>).`, the card title and Markdown body, and a fixed closing contract telling the child to advance the card with `devflow_transition` (registering deliverables via `devflow_attach_artifact` first) or move it to `blocked` with a reason instead of guessing. Between the body and the closing contract, a stage with `inputs` inlines each fed artifact's full content under a `--- artifact <kind> (rev N) ---` separator, and a stage with `produces` states the deliverable kind — with a template skeleton of its required frontmatter fields and `## ` sections when the spec service declares one — plus the instruction to register it through the kind + content form.

#### Token effect

One prompt per dispatched card, proportional to the card body plus the fixed contract lines; a stage with `inputs` additionally pays the full content of each fed artifact (its newest registration, however large) per dispatch, and `produces` adds a bounded template block. The driver adds nothing to any other request.

#### KV Cache effect

Independent: every dispatch is a fresh child session whose request shares no prefix with the parent or with other cards.

## Known Limitations and Deferred Work

- **One executor kind** — every driven stage dispatches a one-shot subagent; the PRD's same-session `goal` and fresh-agent Ralph executors wait until the driver can own a live host agent per card.
- **The child's toolset is the deployment's problem** — the driver does not verify that the chosen provider's children can see the devflow tools; a child without them can only report back and the card stays put.
- **A provider name that never appears leaves its cards pending** — provider registration is dynamic, so the driver cannot distinguish a misspelling from a provider bundle that will activate later; the debug log names the unresolved provider.
- **The activation sweep covers only the default root** — cards in other workspace roots dispatch through their `stage-changed` events; one already parked at a driven stage in another root waits for its next move.
