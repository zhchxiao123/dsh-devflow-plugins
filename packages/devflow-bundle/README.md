# @zhchxiao123/dsh-devflow-bundle

One-command install for the [devflow](../../README.md) plugin line. This package has no behavior of its own — its substance is `cordis.patch.yml`, the mount list that `dsh plugin add` applies to a profile.

## Install

```sh
dsh plugin --profile web add @zhchxiao123/dsh-devflow-bundle
```

That is the whole install. `dsh plugin add` forwards to pnpm, then reconciles the profile's `dsh.profile.bundles` layer stack against what got installed: a dependency whose manifest declares `dsh.bundle` joins the stack, so this package appends itself and its patch mounts every row below. No profile file to edit.

## What it mounts

| Row | Enabled | Why |
|---|---|---|
| `devflow` (the filesystem store) | yes | `root` unset on purpose: each caller's own workspace resolves it, which is what lets one harness serve many projects |
| `devflow-tool` | yes | the model-facing plane |
| `devflow-command` | yes | the `/devflow` intervention plane |
| `devflow-fs-guard` | yes | keeps the store the only write path over card history |
| `devflow-parent-gate` | yes | completion policy for decomposed requirements |
| `devflow-gates` | **no** | an empty gate set vetoes nothing, and which commands guard which edge is a project decision |
| `devflow-driver` | **no** | it spends model budget the moment a card moves; turn it on deliberately |
| `devflow-web` | yes | the board's host half — the read route and the change stream |

Every row keeps the controls it would have had if you had composed it by hand. Override any of them from your profile's own `cordis.patch.yml`, which applies after every bundle layer:

```yaml
- devflow-driver:
    disabled: false
- devflow-gates:
    disabled: false
    config:
      edges:
        'developing->reviewing': ['pnpm run test']
      approvals: ['reviewing->testing']
```

## The board is not in this bundle yet

`@zhchxiao123/dsh-devflow-ui` is deliberately absent. A package that declares `dsh.client` without shipping `lib/client.js` is a **fatal** composition error — the harness refuses to boot at all rather than starting without that plugin — so mounting the board before its browser bundle exists would brick every install. It arrives as one added row once that bundle is built; the host half it reads (`devflow-web`) is already mounted, so nothing else changes.

## Model Experience

None, as this package contributes a mount list and registers no prompt, schema, or tool. The model-facing surface belongs to [`dsh-devflow-tool`](../devflow-tool/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **The board is not mounted** — see above; it returns with its browser bundle.
- **Gate and driver defaults are off** — a bundle cannot know a project's test commands or its model budget, so the two rows that need those answers ship disabled rather than guessing.
