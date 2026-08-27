# Releasing

Eleven packages publish together at one version, because they depend on each
other by `^<version>`: a package left behind resolves a sibling that does not
exist yet. `pnpm run set-version` moves them together and `pnpm run preflight`
refuses a workspace where they have drifted.

Releases run in CI. A laptop can do it, but npm now refuses a publish that is
not backed by 2FA or a granular token, so the token CI needs is the same one a
local publish would need — and CI reruns every gate against a clean checkout,
which a laptop does not.

## Once, before the first release

Create a **granular access token** at
[npmjs.com → Access Tokens → Generate New Token → Granular Access Token](https://www.npmjs.com/settings/~/tokens):

| Field | Value |
|---|---|
| Packages and scopes | **Read and write**, scope `@zhchxiao123` |
| Bypass 2FA | **enabled** — without it npm refuses an automated publish |
| Expiration | your call; the release fails loudly when it lapses |

A classic automation token is not enough: npm answers `E403 ... granular access
token with bypass 2fa enabled is required`.

Then store it as a repository secret:

```sh
gh secret set NPM_TOKEN -R zhchxiao123/dsh-devflow-plugins
# paste the token when prompted; it is never echoed
```

## Every release

```sh
pnpm run set-version 0.1.0      # move all eleven together
pnpm run verify && pnpm run build && pnpm run preflight   # the same gates CI runs
git commit -am "release: 0.1.0"
git tag v0.1.0
git push && git push --tags
```

Pushing the tag is what publishes. `.github/workflows/release.yml` checks that
the tag names the version the packages carry, reruns typecheck, lint, tests, the
build, and the preflight, and only then runs `pnpm publish -r`.

Running the gates locally first is not redundant — it is how you find out
before the tag exists, and a tag is awkward to take back.

## Publishing from a laptop instead

```sh
npm login
pnpm run release       # verify -> build -> preflight -> publish
```

This needs 2FA enabled on the account, and npm will prompt for an OTP per
package. With 2FA off it fails at the first publish with `E403`.

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

It also refuses a version already on the registry. That check is why a failed
release is safe to retry: `pnpm publish -r` goes package by package and stops at
the first failure, so a half-finished release leaves the published ones alone
and the preflight tells you which those were.

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

## Deferred

**npm provenance.** The repository is public and the release workflow already
requests `id-token: write`, so `--provenance` would attest each tarball to the
commit and workflow that built it. It is left off until the first release has
gone through, so a first attempt fails for reasons about this code rather than
about attestation.
