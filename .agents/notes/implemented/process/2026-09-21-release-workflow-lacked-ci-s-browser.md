# Agent Note: The Release Workflow Ran CI's Suite Without CI's Browser

Status: implemented

## Problem

`release.yml` and `ci.yml` both run this repository's full gate, and the release
one reruns it deliberately — "a release is the one action that cannot be taken
back", as its own comment says. But the two workflows set their runners up
differently, and only `ci.yml` installed the browser.

`ci.yml`'s verify job runs
`pnpm --filter @zhchxiao123/dsh-devflow-midscene exec playwright install --with-deps chromium`
before the gates. `release.yml` went straight from `pnpm install --frozen-lockfile`
to `pnpm run verify`. `devflow-midscene`'s acceptance specs drive a real
Chromium; without one they do not skip, they fail — `Failed to launch browser`,
surfacing as `expected 'infrastructure-error' to be 'passed'`.

So every gate passed on the pull request and the same gate failed on the tag.
`devflow-midscene` landed after `v0.4.0-dev.7`, and `v0.4.0-dev.9` was the first
release attempt since, which is why a gap that had been there for ten days
showed up only when someone cut a release.

The failure mode was benign — `verify` precedes `build`, `preflight`, and
`publish`, so nothing was published and the version stayed free for a retry.
Benign but not cheap: it costs a tag, and the tag has to be moved or burned.

## Decision

`release.yml` installs the browser exactly as `ci.yml` does, immediately after
the install step and before the tag check.

The step carries a comment saying why it is there, because its absence is
invisible: nothing about `pnpm run verify` announces that it needs a browser,
and the next person tempted to trim the release workflow would find an
unexplained Playwright install and assume it was copied in by accident.

`v0.4.0-dev.9` was re-pointed at the fixed commit rather than abandoned. Moving
a tag is normally wrong, but this one published nothing — no consumer had seen
the version, and burning it would leave a hole in the sequence recording only
that a workflow lacked a setup step.

## The rule this is an instance of

**Two workflows that run the same gate must set up the same environment.** The
gate is `pnpm run verify`, and it is not self-contained: it assumes a browser
its `package.json` cannot install for it. Any divergence in setup between
`ci.yml` and `release.yml` means the release gate is not the gate the pull
request passed, which defeats the reason the release reruns it at all.

When a package adds an external runtime dependency to the suite — a browser, a
database, a system library — it belongs in both workflows in the same change.

## Alternatives considered

**Make the suite install its own browser.** A `globalSetup` or pretest hook in
`devflow-midscene` would make `verify` self-contained and immune to workflow
drift. Rejected for now: `playwright install` is slow and network-bound, and
putting it inside the suite would run it on every local `vitest` invocation,
where the browser is usually already present. The cost lands on the common path
to protect the rare one.

**Skip the browser specs when no browser is present.** That converts a loud
failure into a silent gap in coverage, and the specs that need a real Chromium
are exactly the ones asserting that acceptance is real rather than mocked. A
release gate that quietly stops checking the thing it exists to check is worse
than one that fails.

**Have `release.yml` call `ci.yml` as a reusable workflow** so the setup cannot
diverge by construction. This is the structurally correct fix and remains open.
It was not taken here because the trusted-publishing grant is bound to this
workflow's **filename** and ref; restructuring the job is exactly the change
`RELEASING.md` warns requires updating the trusted publisher on every package
first, and that is not a change to make while a release is in flight.

**Burn `0.4.0-dev.9` and release `dev.10`.** Rejected: nothing was published at
dev.9, so the version is untouched, and a skipped version number invites a
future reader to look for the release that used it.

## Consequences

The release workflow is slower by one browser install. That is the cost of the
release gate being the same gate CI ran.

The two workflows still duplicate their setup, so they can still drift. The
reusable-workflow alternative above is the durable fix and is blocked on the
trusted-publisher rebinding; until it is taken, a package adding a runtime
dependency to the suite has to remember both files. `RELEASING.md` already
carries the neighbouring lesson — the preflight blind spot — and both share a
root: a release-time check that looks like the pull-request check but is not.

## Related

- [The preflight blind spot](../../../../RELEASING.md) — the other gap found in
  the same release attempt: preflight passes a package that can never publish.
