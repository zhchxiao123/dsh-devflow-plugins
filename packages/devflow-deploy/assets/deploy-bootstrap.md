# deploy-bootstrap

Write and maintain this project's `deploy.yml`, and decide what to do when a
deploy goes wrong. The `deploy_*` tools execute a manifest; producing a correct
one, and reading a failure, is your work.

Published releases outlive the session. That is the whole point of this
capability, and it is also why every judgement below is worth making carefully:
nothing here gets cleaned up when the session ends.

## 1. Survey before writing anything

Find what this project actually publishes. Do not guess from the directory
name, and do not converge on the first candidate you find.

Read, in this order — the earlier sources are more reliable than the later:

1. **CI configuration** (`.github/workflows/`, `.gitlab-ci.yml`, …). A project
   that already publishes almost always does it here, and the workflow names
   the real build command and the real output directory.
2. **Package scripts** — `build`, `build:prod`, `docs:build`. Note which one
   produces a *site* rather than a library bundle.
3. **Build-tool configuration** — `vite.config.*`, `next.config.*`,
   `astro.config.*`, `docusaurus.config.*`. The output directory is declared
   there and is often not `dist/`.
4. **`.gitignore`** — the ignored build output names the artifact directory.

Record what you found and what you rejected in the manifest's header comment.
The next session reads that instead of repeating this survey.

## 2. Confirm the target is a site, not a library

A `dist/` full of `.js` and `.d.ts` files is a published package, not a
deployable site. If the build produces no entry document, say so and stop —
do not invent one. A project may simply have nothing to deploy.

## 3. A service that is not containerised yet

`kind: service` deploys a container. If the project is a deployable service —
a Spring Boot app, a Go binary, anything with a long-running process — but has
no `Dockerfile` and no `docker-compose.yml`, you may write them. They are the
project's own files, not the plugin's, so two rules bind that work:

**Ask first, and write nothing before the answer.** Propose what you would add
— base image, build stages, exposed port, health check — and wait. A repository
gains permanent infrastructure here; that is the user's call, not a step you
take on the way to deploying.

**The compose file must interpolate the tag variable**, because that is the
whole mechanism by which a deploy changes what runs:

```yaml
services:
  api:
    image: myapp:${APP_IMAGE_TAG}
```

A compose file that hardcodes `:latest` deploys nothing — `deploy_target`
refuses it in preflight for exactly that reason.

**Give the image a HEALTHCHECK, or declare an http/tcp check in the manifest.**
`ready` decides whether a deploy succeeded; without one of these it cannot
answer, and the target cannot be deployed.

If the project is a library, a script collection, or has no long-running
process, say that it is not deployable as a service and stop. Do not invent a
container for something that is not one.

## 4. Write the manifest

```yaml
# Surveyed 2026-09-03. Candidates: `pnpm build` (chosen, from ci.yml:24),
# `pnpm build:lib` (rejected — emits a package, no index.html).
targets:
  landing:
    kind: static
    build: pnpm run build
    dir: dist
    entry: index.html

  api:
    kind: service
    build: mvn -q package          # produces the jar the Dockerfile copies
    image: myapp                   # no tag: the driver tags each release
    context: .
    service: api                   # the compose service to restart
    ready: { http: 'http://127.0.0.1:8080/healthz' }
```

- `build` is optional. Omit it only when the artifact is committed or produced
  by something outside this project.
- **`static`** — `dir` is relative to the workspace root and must stay inside
  it. `entry` defaults to `index.html` and is checked for existence only: that
  it exists proves a build ran, not that the site is correct.
- **`service`** — `image` carries no tag; the driver tags each release itself.
  `ready` is required, in one of three forms: `{ http: <url> }`,
  `{ tcp: <port> }`, or `{ docker: health }` for the container's own
  HEALTHCHECK.

**The target name becomes the public URL path.** Choose it deliberately;
renaming it later publishes a second site rather than moving the first.

## 5. Verify locally before publishing

`deploy_target` checks that the artifact exists, is not empty, has its entry
document, and contains no symlink leaving it. It does not check that the site
*works*. Before deploying something visitors will see:

- open the built entry document and confirm it is the page you expect;
- check that asset paths resolve under the target's URL prefix — a site built
  for `/` often breaks when served from `/<target>/`, and this is the single
  most common way a deploy succeeds while the page renders blank.

## 6. Read the failure by its phase

Every failure names the phase it happened in. The phase tells you where you
stand:

| Phase | What it means | Far side |
|---|---|---|
| `resolve` | The manifest is missing, invalid, or names no such target | untouched |
| `build` | The project's own build command failed | untouched |
| `preflight` | The artifact or the host failed a check | **untouched** |
| `transfer` | The upload failed partway | previous release still live |
| `activate` | The switch itself failed | `static`: previous release still live. **`service`: the driver already retreated — read what it says happened** |
| `verify` | The new container never reported ready | the driver retreated; read the outcome |
| `prune` | Cleanup of superseded releases failed | **the deploy succeeded** |

For `static`, a failure through `activate` means the previous release is still
serving: there is nothing to undo, and rolling back would be wrong. Fix the
cause and deploy again.

For `service` there is no atomic switch, so a failed activation or verification
puts the previous release back on its own and **tells you which of three things
happened**:

- *"the previous release … was restored and is healthy"* — the service is fine.
  Fix the new release and deploy again.
- *"restored but IS NOT HEALTHY … needs attention"* — **the service is down.**
  Say so immediately and stop; this is not something to iterate through.
- *"there was no previous release to return to"* — a first deploy failed, so
  nothing was ever serving. Fix and retry; nothing is broken.

A `prune` failure is reported as a warning on a *successful* deploy. Do not
treat it as a deployment failure; it means old releases are accumulating.

## 7. Choose between fixing forward and rolling back

Roll back when **what is live is wrong** — the new release deployed
successfully but is broken for visitors. Fix forward when the deploy never
took effect.

Before rolling back, read `deploy_status`. It reports what each target's kind
promises:

- **`atomic`** — one operation returns the previous release, with no
  interruption and no re-transfer. Safe.
- **`disruptive`** — reversible, but service is interrupted while the
  activation flow re-runs. Say so before doing it.
- **`unsupported`** — no rollback is promised, and the tool will refuse.
  Do not look for a workaround; fix forward.

`deploy_status` also lists earlier releases. Pass one to `deploy_rollback` to
go further back than the immediately previous release.

## 8. Repair a manifest that has rotted

A manifest goes stale when the project changes its build. The symptoms are a
`build` phase failure naming a script that no longer exists, or a `preflight`
failure saying the artifact directory is missing or empty.

Re-run the survey in §1 against the current tree, update the manifest, and
update its header comment to say what changed and why. A manifest whose
provenance comment no longer matches its contents is worse than one with no
comment.

## What this skill does not decide

Where the server is, how it authenticates, and what URL prefix it serves are
operator configuration, not manifest content. If a deploy fails because the
host cannot be reached, that is a configuration problem to report, not one to
work around by editing the manifest.
