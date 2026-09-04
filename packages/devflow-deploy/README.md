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

  api:
    kind: service
    build: mvn -q package
    image: myapp                  # no tag: the driver tags each release
    service: api                  # the compose service to restart
    ready: { http: 'http://127.0.0.1:8080/healthz' }
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
    host: deploy@example.com          # or a ~/.ssh/config alias
    drivers:
      static:
        remoteWebRoot: /srv/www       # what the web server serves
        remoteReleasesRoot: /srv/releases
        baseUrl: https://example.com  # the URL prefix for remoteWebRoot
      service:
        composeDir: /opt/app          # the compose project on the host
```

Settings live under `drivers`, one section per kind, because kinds do not share
a remote layout. The core does not know a section's shape — the kind validates
its own, exactly as it validates its own manifest fields. Configuring no kind
at all, or a kind this package does not ship, fails at load.

Address fields have no defaults. A guessed remote path would let a
misconfigured composition publish where nobody is looking, so an incomplete
section fails at load. `remoteReleasesRoot` must sit outside `remoteWebRoot`,
which is also checked at load.

Shared: `manifestPath` (`deploy.yml`), `buildTimeoutMs` (600000),
`remoteTimeoutMs` (120000), `logTailBytes` (65536), `graceMs` (5000).
Per `static`: `keepReleases` (5). Per `service`: `tagVarName`
(`APP_IMAGE_TAG`), `remoteTmpDir` (`/tmp`), `keepImages` (5),
`verifyTimeoutMs` (120000), `readyPollIntervalMs` (2000).

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

## The `service` kind

A release is an image tag, and the pointer to it is one line of the compose
project's `.env`:

```
<image>:<releaseId>       the version, in the host's image store
<composeDir>/.env         the pointer, read by `docker compose up -d`
```

A deploy builds the image locally, ships it with `docker save` → `rsync` →
`docker load`, points the variable at the new tag, brings the service up, and
waits for the declared `ready` check. **Save and load are separate commands,
never one pipe**: `pipefail` is not POSIX, so a pipe would report only the last
command's exit status and a failed `save` would surface as an ambiguous
downstream error.

There is no atomic switch — once the container restarts, the previous one is
gone — so an activation or verification failure **puts the previous release
back on its own** and reports which of three things happened: the previous
release is healthy again, it was restored but is *not* healthy (the service is
down and needs a human), or there was never a previous release to return to.
Those three call for very different next steps, which is why they are never
collapsed into one failure message.

**Set up once:** the compose file must interpolate the tag variable, e.g.
`image: myapp:${APP_IMAGE_TAG}`. A compose file that hardcodes a tag is refused
in preflight, because deploying would not change what runs. This package never
writes `docker-compose.yml`; it owns one variable in `.env` and leaves every
other line of that file byte-for-byte.

## Known boundaries

- One server per plugin instance.
- Deploys are assumed to be serial; two agents publishing the same target
  concurrently leave whichever switched last in place.
- A failed prune is reported as a warning on a successful deploy, not as a
  failure.
- `entry` is checked for existence only. That a site *works* is the skill's
  concern, not the tool's.
- `service` assumes one instance and does not drain a load balancer; the
  interruption is the container restart.
- Images transfer whole every time — `docker save` has no layer reuse. Moving
  to a registry is contained in one module.
