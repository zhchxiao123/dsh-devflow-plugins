# @zhchxiao123/dsh-devflow-deploy

English | [中文](README.zh.md)

Persistent deployment for the DeepSeek Harness. A `deploy.yml` in your
repository names what the project publishes; the `deploy_*` tools publish it to
a server and report where it can be reached.

**What this publishes outlives the session.** That is the opposite promise from
[`dsh-devflow-testenv`](../devflow-testenv/README.md), whose environments are
guaranteed to be torn down. Nothing on the far side is registered as an effect
here: disposing the plugin removes its tools and its skill and leaves every
release exactly where it is.

## The manifest

```yaml
targets:
  landing:
    kind: static
    build: pnpm run build
    dir: dist
    entry: index.html
```

`kind` selects the driver. `build` is an optional pre-step. Every other field
belongs to the kind, and the core hands it over without inspecting it.

**The target name becomes the URL path**, so it is restricted to lowercase
letters, digits, and inner hyphens. That restriction is a security invariant —
the name reaches remote paths — and is fixed rather than configurable.

Declaring targets in the repository, rather than passing a name to the tool, is
deliberate: a mistyped name would otherwise publish a second site silently, and
here it is a validation error naming the declared targets.

## Configuration

```yaml
- name: '@zhchxiao123/dsh-devflow-deploy'
  config:
    host: deploy@example.com      # or a ~/.ssh/config alias
    remoteWebRoot: /srv/www       # what the web server serves
    remoteReleasesRoot: /srv/releases
    baseUrl: https://example.com  # the URL prefix for remoteWebRoot
```

The four address fields have no defaults. A guessed remote path would let a
misconfigured composition publish where nobody is looking, so an incomplete
configuration fails at load. `remoteReleasesRoot` must sit outside
`remoteWebRoot`, which is also checked at load.

Optional: `manifestPath` (`deploy.yml`), `keepReleases` (5), `buildTimeoutMs`
(600000), `remoteTimeoutMs` (120000), `logTailBytes` (65536), `graceMs` (5000).

**No credential appears in the configuration.** SSH authentication belongs to
the machine the harness runs on — key, agent, `known_hosts` — and this package
holds no key material and validates none. Remote commands are run with
`BatchMode=yes`, so a missing key is a failure rather than a prompt.

## Tools

| Tool | What it does |
|---|---|
| `deploy_target` | Build, publish as a new release, switch to it, prune old releases |
| `deploy_status` | What is live, at what address, with what rollback promise |
| `deploy_rollback` | Return to an earlier release without rebuilding or re-transferring |

A bundled `deploy-bootstrap` skill owns writing and repairing the manifest,
verifying a target before publishing it, and choosing between fixing forward
and rolling back.

## What a rollback promises

Deployment kinds differ most in whether they can be undone, so the promise is
per-kind and queryable rather than uniform. `deploy_status` reports it:

- **`atomic`** — one operation returns the previous release, with no
  interruption and no re-transfer.
- **`disruptive`** — reversible, but service is interrupted while the
  activation flow re-runs.
- **`unsupported`** — no rollback is promised; `deploy_rollback` refuses,
  naming the reason, and issues no remote command.

A driver declares its class statically, and a driver that omits `rollback` *is*
`unsupported` — the registry refuses one whose promise and implementation
disagree, so a kind cannot advertise a rollback it did not write.

## Phases

`resolve → build → preflight → transfer → activate → verify → prune`

Not every kind uses every phase, but the vocabulary is closed, so failure
reports read the same across kinds. Every failure names its phase, the command
as it ran, how it ended, and its output tail.

**`preflight` is the boundary that matters**: a failure at or before it leaves
the far side untouched. Through `activate`, the previous release is still
serving, so a failure there is fixed by deploying again, not by rolling back.

## The `static` kind

```
<remoteReleasesRoot>/<target>/<releaseId>/   the payload, never served
<remoteWebRoot>/<target>                     a symlink to it, served
```

`rsync` copies the artifact into a **fresh** release directory — no `--delete`,
so a mistake in the destination path cannot destroy anything, and the previous
release stays intact throughout the transfer. The switch stages a new symlink
and renames it over the live one, which is atomic: a visitor sees either the
old release or the new one.

Rolling back is that same rename in the other direction, which is why this kind
is `atomic`. The current release and the one before it are never pruned.

Payloads are kept outside the served tree rather than hidden inside it, so the
isolation does not depend on your web server's dotfile rules.

**Set up once:** point the web server at `remoteWebRoot` and let it follow
symlinks. This package does not generate or modify web-server configuration.

**Requires GNU coreutils on the server** — the atomic switch uses `mv -T`.
Remote commands are POSIX `sh`; Windows servers are not supported.

## Known boundaries

- One server per plugin instance.
- Deploys are assumed to be serial; two agents publishing the same target
  concurrently leave whichever switched last in place.
- A failed prune is reported as a warning on a successful deploy, not as a
  failure.
- `entry` is checked for existence only. That a site *works* is the skill's
  concern, not the tool's.
