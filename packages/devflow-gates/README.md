# @zhchxiao123/dsh-devflow-gates

English | [中文](README.zh.md)

Command gate policies on the [`devflow/transition`](../devflow/README.md) waterfall: a configured edge runs its gate commands through `ctx.shell` before the journal commits, and a failing command vetoes the move with a bounded output summary in the rejection reason. Gate commands live entirely in deployment configuration — global per-edge lists plus per-card overrides keyed by card id — never in the card's writable files, so a developing agent cannot rewrite its own gates.

## Behavior

For an attempt on edge `from->to`, the guarding commands are `cards[<card id>][edge]` when present, else `edges[edge]`, else none (an ungated edge delegates untouched). Commands run through `ctx.shell.resolve`/`run` in the card's workspace directory — the parent of the attempt's devflow root, so a gate like `pnpm run test` checks the code the card belongs to — with the edge's `policies` entry supplying its timeout, working directory, and whether the commands run concurrently. Sequentially (the default) the first non-zero exit or kill vetoes without running the rest; in `parallel` every command runs and the veto names each that failed. A veto carries `gate command failed: <command> (exit N | killed): <stderr+stdout summary>` truncated at `maxFailureOutputChars`, plus `full output: <path>` when `failureLogDir` is set. All-green gates delegate to the remaining waterfall listeners.

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
    policies:
      'developing->reviewing':
        timeoutMs: 900000
        parallel: true
    failureLogDir: .devflow-gate-logs
    maxFailureOutputChars: 2000
```

| Key | Default | Meaning |
|---|---|---|
| `edges` | `{}` | Global gate commands per `from->to` edge. |
| `cards` | `{}` | Per-card overrides replacing the global list for that edge. |
| `approvals` | `[]` | Edges requiring a one-shot human approval after their commands pass. |
| `policies` | `{}` | Per-edge `timeoutMs`, `workdir`, and `parallel`. |
| `failureLogDir` | — | Directory receiving the complete output of a failed command; the veto names the file. Unset keeps the truncated summary as the only record. |
| `maxFailureOutputChars` | `2000` | Character cap for the failure-output summary in a veto reason. |

An edge key not of the form `<from>-><to>` with known location names fails the load, in `policies` as in `edges`; so does a non-positive `timeoutMs`.

**Set `timeoutMs` on any edge that runs a test suite.** The executor's default sizes a check, and `developing->reviewing` running `pnpm run test` is the first thing most deployments configure — a suite that outlives the default is killed, and the gate reports the kill as a failure of the code rather than of its own budget.

`parallel` trades the sequential short-circuit for one round trip: every command runs and the veto names each that failed. It suits independent checks (lint, types, tests) and not a chain where a later command presupposes an earlier one.

## Model Experience

None, as gate vetoes reach a model only through the devflow tools' rejection text; this plugin registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Approvals need a live initiating agent** — the approval seam is agent-scoped, so a human- or command-initiated move on an approval edge always takes the parked-blocked path; even [`/devflow move`](../command-devflow/README.md) goes through the same executor without a bypass, so an approval edge is crossable only by an agent with a reachable approval responder.
- **Gate results are not cached or incremental** — every attempt at an edge reruns that edge's commands in full, so a rework loop pays for the whole suite each time round. Reusing a previous result needs a notion of what the commands depend on, which this package does not have.
- **The full failure output goes to a file, not to the card** — `failureLogDir` is a plain directory the deployment names, because a gate cannot register an artifact against the card it is gating: the store serializes per card and this waterfall runs inside the transition holding that card's turn, so `attachArtifact` would wait for a transition that is waiting for it. Putting the output on the card needs a seam that accepts a write from inside its own waterfall.
