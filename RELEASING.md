# Releasing

Eleven packages publish together at one version, because they depend on each
other by `^<version>`: a package left behind resolves a sibling that does not
exist yet. `pnpm run set-version` moves them together and `pnpm run preflight`
refuses a workspace where they have drifted.

## Once, before the first release

1. **Log in to npm** as the account that owns the `@zhchxiao123` scope:

   ```sh
   npm login
   npm whoami          # must print zhchxiao123
   ```

2. **Create the scope on the registry.** A scope exists the moment its first
   package is published, and the first publish of a scoped package needs
   `--access public` — which `pnpm run release` passes, so nothing to do here
   beyond having the account.

3. **For releasing from CI instead of a laptop**, add an npm automation token
   as the `NPM_TOKEN` repository secret:

   - npm → Access Tokens → Generate New Token → **Automation**
   - GitHub → Settings → Secrets and variables → Actions → New repository secret,
     named `NPM_TOKEN`

   `.github/workflows/release.yml` uses it. Skip this if you only ever publish
   locally.

## Every release

```sh
pnpm run set-version 0.1.0     # or whatever this release is
pnpm run release               # verify -> build -> preflight -> publish
```

`release` refuses to publish unless the whole chain passes, in this order:

| Step | What it refuses |
|---|---|
| `verify` | a typecheck, lint, or test failure |
| `build` | — (it produces `lib/`, which the manifests point at) |
| `preflight` | a tarball missing a file its manifest names, a surviving `workspace:` range, `devflow-ui` without `lib/client.js`, drifted versions, a version already on the registry |

Then tag what you shipped:

```sh
git commit -am "release: 0.1.0" && git tag v0.1.0
git push && git push --tags
```

If `NPM_TOKEN` is set, pushing the tag is enough on its own — the release
workflow reruns every gate and publishes. Doing both is harmless: the second
attempt fails at `preflight`, which is the point of that check.

## What preflight is protecting you from

It reads the **tarballs**, not the working tree, because the failures that
matter are invisible from a checkout. Two of them have already happened here:

- **A manifest pointing at a file the build never produced.** Every package
  declared `main: lib/index.js` while only `lib/types/` was ever written, so a
  publish would have shipped eleven empty shells.
- **A build step deleting another's output.** tsdown's default `clean` wipes its
  `outDir`, which is the same `lib/` that `tsc -b` had just written declarations
  into — and incremental tsc, seeing its `.tsbuildinfo`, would not write them
  again. The packages would have published with no types at all.

The one it protects a *consumer* from is `devflow-ui` without `lib/client.js`:
a harness treats a `dsh.client` declaration with no bundle as fatal and refuses
to boot, so that is not a degraded install but a broken one.

## Versioning

Pre-1.0, so a breaking change bumps the minor. What counts as breaking for a
plugin line:

- a route path, WebSocket path, sidebar page id, tool name, or `/devflow`
  subcommand changing — these are what a deployment and a model have learned;
- a `Config` field losing its meaning or its default;
- the `.devflow` on-disk format changing in a way an existing journal cannot
  replay;
- the pinned harness version moving, because a plugin built against one exact
  prerelease is not guaranteed to load on another.

Bumping the harness is its own release: change the pin in every package, run
the whole chain, and say so in the release notes.
