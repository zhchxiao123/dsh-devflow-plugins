# devflow for DeepSeek Harness

File-based development state for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): work is a **card**, a card's history is an append-only journal, and every stage move commits at that journal. Eleven plugins over one capability seam (`ctx.devflow`), composed à la carte; the Harness agent is the workflow executor.

This repository is the standalone plugin line. It depends only on harness packages published to npm — nothing here patches the harness.

## The packages

| Package | Role |
|---|---|
| `@zhchxiao123/dsh-devflow` | Service Definition of the `ctx.devflow` seam: card vocabulary, journal decode/replay |
| `@zhchxiao123/dsh-devflow-filesystem` | Service Provider: `.devflow/` on disk, `O_EXCL` leases, month-bucket archiving |
| `@zhchxiao123/dsh-devflow-gates` | Gate policy on the transition waterfall: per-edge commands plus one-shot human approvals |
| `@zhchxiao123/dsh-devflow-parent-gate` | Completion policy: a decomposed requirement reaches `done` only after every sub-requirement does |
| `@zhchxiao123/dsh-devflow-fs-guard` | Denies the agent's file tools any write under `.devflow/`, keeping the store the only write path |
| `@zhchxiao123/dsh-devflow-artifact-gate` | Mechanical artifact contract over configured transition edges |
| `@zhchxiao123/dsh-devflow-agent-gate` | Independent LLM admission checks over registered artifacts |
| `@zhchxiao123/dsh-devflow-tool` | The model-facing tools (`devflow_list`, `devflow_create`, `devflow_transition`, …) |
| `@zhchxiao123/dsh-devflow-command` | The deterministic `/devflow` intervention plane |
| `@zhchxiao123/dsh-devflow-web` | devflow's own browser channel: a read-only JSON route plus a change stream |
| `@zhchxiao123/dsh-devflow-ui` | The board, browser half: a sidebar page where a sidebar foundation is composed, a floating control otherwise |

Three planes move a card and they are separate on purpose: the model uses the tools, a human intervenes through `/devflow`, and approvals ride the harness's approval plane. The web board is **read-only** — the route projects two reads and no write verb has an endpoint at all.

## Harness version

Every harness dependency is pinned to one exact prerelease (`0.1.1-rc.2`), never a range: `^0.1.1-rc.2` does not match a later prerelease, and a floating range across a pre-1.0 harness is how a plugin line silently stops loading.

## Install into a harness

```sh
dsh plugin --profile web add @zhchxiao123/dsh-devflow-bundle
```

That is the whole install: `dsh plugin add` forwards to pnpm and then reconciles the profile's bundle stack against what got installed, so the bundle mounts every devflow row by itself — no profile file to edit. The board comes with it. See [`devflow-bundle`](packages/devflow-bundle/README.md) for what mounts, what ships disabled, and how to override a row.

## Getting started (development)

```sh
git clone https://github.com/zhchxiao123/dsh-devflow-plugins.git
cd dsh-devflow-plugins
pnpm run init
```

`init` installs against the recorded lockfile, then typechecks, lints, and tests — a clean checkout either reproduces or tells you the harness moved. After that:

```sh
pnpm run verify        # typecheck + lint + test, the pre-push gate
pnpm run test:coverage # per-file 100% on packages/*/src
pnpm run build         # emit lib/types
```

Workspace packages resolve to each other through `tsconfig.base.json` `paths` (the source plane) in tests and typecheck; consumers resolve them through `exports` to built `lib/`.

## Where the work is described

This repository carries its own development record, moved with the code:

| Path | What lives there |
|---|---|
| `.agents/prd/` | six PRDs — what each change set was for and what was ruled out |
| `.scratch/devflow/` | 22 issues sliced from those PRDs, each with its resolution |
| `.agents/notes/implemented/` | Agent Notes — the decisions, the alternatives, and why |
| `.agents/skills/` | how to work here: prose standard, code review, note hygiene |
| `docs/devflow.md` | the subsystem walkthrough |
| `AGENTS.md` | the conventions this line holds itself to |

Start from `AGENTS.md`; it opens with the one rule that shapes the rest — **this line depends only on published harness surface.**

## Releasing

Twelve packages publish together at one version. See [RELEASING.md](RELEASING.md); the short form is `pnpm run set-version <v> && pnpm run release`, which refuses to publish unless typecheck, lint, tests, the build, and a tarball preflight all pass.

## Testing

Tests cover every package, including the board's — `tests/loader-factory.ts` runs the harness's published client bundles through a module table so the browser-half specs use the real `SlotRegistry` rather than a double. Per-file 100% coverage on `packages/*/src` is the gate, and the install path itself is verified against a real harness boot.
