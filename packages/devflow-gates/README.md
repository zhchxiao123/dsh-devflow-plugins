# @zhchxiao123/dsh-devflow-gates

English | [中文](README.zh.md)

Command gate policies on the [`devflow/transition`](../devflow/README.md) waterfall: a configured edge runs its gate commands through `ctx.shell` before the journal commits, and a failing command vetoes the move with a bounded output summary in the rejection reason. Gate commands live entirely in deployment configuration — global per-edge lists plus per-card overrides keyed by card id — never in the card's writable files, so a developing agent cannot rewrite its own gates.

## Behavior

For an attempt on edge `from->to`, the guarding commands are `cards[<card id>][edge]` when present, else `edges[edge]`, else none (an ungated edge delegates untouched). Commands run in order through `ctx.shell.resolve`/`run` in the card's workspace directory — the parent of the attempt's devflow root, so a gate like `pnpm run test` checks the code the card belongs to; the first non-zero exit (or kill) vetoes without running later commands, carrying `gate command failed: <command> (exit N | killed): <stderr+stdout summary>` truncated at `maxFailureOutputChars`. All-green gates delegate to the remaining waterfall listeners.

## Human approvals

An edge listed in `approvals` additionally requires a one-shot human decision after its commands pass, answered over the interaction plane (`ctx.approval`) — never through the model conversation, because the gate exists to check the agent. The approval request routes to the initiating agent's answerers (`attempt.by.session` resolved through `ctx.agents`); an approved move carries `gate: { approvedBy: { kind: 'human' } }` in its journal entry, and a rejected or withdrawn question vetoes without side effects. When no responder is reachable — a non-agent initiator, no composed approval service, or the seam's fail-closed `unavailable` — the move is vetoed and the card is parked `blocked` (`awaiting human approval for <edge>`, actor `command devflow-gates`) so an unattended run exits cleanly; a human recovers the card to its interrupted stage and re-attempts the move.

## Config

```yaml
- id: devflow-gates
  name: '@zhchxiao123/dsh-devflow-gates'
  config:
    edges:
      'developing->reviewing': ['pnpm run test']
    cards:
      0042-retry-backoff:
        'developing->reviewing': ['pnpm run test -- packages/llm']
    maxFailureOutputChars: 2000
```

| Key | Default | Meaning |
|---|---|---|
| `edges` | `{}` | Global gate commands per `from->to` edge. |
| `cards` | `{}` | Per-card overrides replacing the global list for that edge. |
| `approvals` | `[]` | Edges requiring a one-shot human approval after their commands pass. |
| `maxFailureOutputChars` | `2000` | Character cap for the failure-output summary in a veto reason. |

An edge key not of the form `<from>-><to>` with known location names fails the load.

## Model Experience

None, as gate vetoes reach a model only through the devflow tools' rejection text; this plugin registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Approvals need a live initiating agent** — the approval seam is agent-scoped, so a human- or command-initiated move on an approval edge always takes the parked-blocked path; even [`/devflow move`](../command-devflow/README.md) goes through the same executor without a bypass, so an approval edge is crossable only by an agent with a reachable approval responder.
- **Gate commands run with the executor's default working directory and timeout** — per-edge cwd/timeout overrides wait for a consumer that needs them.
