# devflow for DeepSeek Harness

File-based development state for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): work is a **card**, a card's history is an append-only journal, and every stage move commits at that journal. Ten plugins over one capability seam (`ctx.devflow`), composed à la carte.

This repository is the standalone plugin line. It depends only on harness packages published to npm — nothing here patches the harness.

## The packages

| Package | Role |
|---|---|
| `@zhchxiao123/dsh-devflow` | Service Definition of the `ctx.devflow` seam: card vocabulary, journal decode/replay |
| `@zhchxiao123/dsh-devflow-filesystem` | Service Provider: `.devflow/` on disk, `O_EXCL` leases, month-bucket archiving |
| `@zhchxiao123/dsh-devflow-gates` | Gate policy on the transition waterfall: per-edge commands plus one-shot human approvals |
| `@zhchxiao123/dsh-devflow-parent-gate` | Completion policy: a decomposed requirement reaches `done` only after every sub-requirement does |
| `@zhchxiao123/dsh-devflow-fs-guard` | Denies the agent's file tools any write under `.devflow/`, keeping the store the only write path |
| `@zhchxiao123/dsh-devflow-driver` | Claims stage work and drives it through subagent executors |
| `@zhchxiao123/dsh-devflow-tool` | The model-facing tools (`devflow_list`, `devflow_create`, `devflow_transition`, …) |
| `@zhchxiao123/dsh-devflow-command` | The deterministic `/devflow` intervention plane |
| `@zhchxiao123/dsh-devflow-web` | devflow's own browser channel: a read-only JSON route plus a change stream |
| `@zhchxiao123/dsh-devflow-ui` | The board, browser half: a sidebar page where a sidebar foundation is composed, a floating control otherwise |

Three planes move a card and they are separate on purpose: the model uses the tools, a human intervenes through `/devflow`, and approvals ride the harness's approval plane. The web board is **read-only** — the route projects two reads and no write verb has an endpoint at all.

## Harness version

Every harness dependency is pinned to one exact prerelease (`0.1.1-rc.2`), never a range: `^0.1.1-rc.2` does not match a later prerelease, and a floating range across a pre-1.0 harness is how a plugin line silently stops loading.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
```

Workspace packages resolve to each other through `tsconfig.base.json` `paths` (the source plane) in tests and typecheck; consumers resolve them through `exports` to built `lib/`.
