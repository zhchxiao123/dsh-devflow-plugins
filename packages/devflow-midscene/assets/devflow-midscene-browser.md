# Browser checks in the current project

Use this skill to inspect or reproduce UI behavior. Harness owns the execution
and its jobs; the pinned Midscene CLI performs browser actions.

## Discover and prepare

1. Call `midscene_discover`. Derive the application from the current task and
   repository. Static candidates are evidence, not proof of a running service.
2. Read the project's startup runbook and scripts. Use existing Harness shell
   and job tools to start its development server when needed, retain the job id,
   and inspect readiness logs for the actual URL. Check that it belongs to the
   intended application; an unrelated HTTP 200 does not establish identity.
   Do not scan arbitrary ports, install dependencies or run database migrations
   as part of read-only discovery. Use the normal execution permission policy.
3. If several applications remain plausible, ask which one is intended. Remember
   a durable choice using `midscene_project`; do not ask the user to edit JSON.
   Pass temporary discovered addresses directly as `targetUrl` to the run tools.
4. Call `midscene_doctor` with that URL when discovery cannot infer it. The default
   is the initiating DSH session model, including its existing connection and
   credentials. If it is incompatible, select an already configured visual model
   through conversation and store only its provider/model/family reference using
   `midscene_project`. Do not invent a family for an unknown gateway alias.
   Preflight is metadata-only, not a successful model invocation.

## Run and observe

Call `midscene_browser` with the current `card` when testing a task, optional `targetUrl`, action `prompt` and visual
`assertion`. Omit `profile` for project mode; an explicit legacy profile remains
available. Never include passwords or tokens in tool arguments.

Wait for the returned job using existing job tools. Read its output and inspect
saved screenshots before another operation. A started job is not success.
Summarize observations, attempted actions, assertions, failures and report links.
A screenshot-only run reports `observed`, not `passed`.

Project mode owns a fresh Chromium per job. Dependent page interactions belong
in one natural-language action. It does not borrow the user's Codex browser or
copy their login automatically. Use the access-preparation flow below to import
authorized project login state; do not claim protected pages passed without it.
Legacy profiles can also select dedicated CDP/Bridge sessions or private snapshots. Borrowed browsers stay open and require serial operations.

Use job tools to cancel and wait for termination; check cleanup status. Stop
only development services started for this work, using their retained Harness
job ids. Never stop a pre-existing user service. `midscene_inspect` and
`midscene_recover` resolve historical storage without a current URL or model.
Recovery cleans positively identified owned resources; it never replays actions.

## Formal acceptance

Exploration does not authorize task completion. Use `devflow-midscene-acceptance`
for reviewed cases, source/build evidence and fresh completion-gate execution.

## Official reference

The pinned upstream reference is `official-browser/SKILL.md`, with its license
and revision in `official-browser/PROVENANCE.md`. Managed execution uses bundled
@midscene/web 1.12.6, not floating installation commands or project API keys.

## Prepare access with the user

Before protected-page actions, discover the project's login runbook, test roles,
seed data and existing authorized private login snapshot. Ask only for missing
facts in one short message: target environment, required role/tenant, how to log
in, which test data to use, and permission for actions that submit or delete data.
Do not ask again for facts already supplied. Public-page checks need no account.

Use `midscene_project` to remember `authentication: {required: true, role: "..."}`
for protected checks (preserve the existing non-secret project choices). The role
is a label, not a username or password. Use `midscene_auth` to inspect readiness;
missing or unusable login is a preparation blocker, not a product test failure.

Offer these login routes, according to the project:

- Prefer user-assisted login in a dedicated browser. Prepare the browser and
  snapshot export with existing shell/jobs tools; the user only performs login,
  SSO, MFA or CAPTCHA. Do not ask them to hand-author JSON or copy browser cookies
  into chat. Export only the target-origin cookies/localStorage into an owner-only
  Playwright storageState file outside the repository.
- If the project provides test credentials through an approved private file or
  credential service, prepare login from that source outside Midscene's recorded
  action prompts, then export the target-scoped snapshot. Ask the user where the
  authorized credentials are stored, not to paste a password into the conversation.
  Never invent credentials or copy an unrelated browser profile.

Call `midscene_auth` with `action: "import"` and `snapshotFile` once the authorized
snapshot exists. The tool validates origin and permissions and stores a private
copy scoped to this project, origin and role. `action: "clear"` removes that copy.
No path, cookie or password belongs in `.devflow/midscene/settings.json` or suites.

An available snapshot is not proof the server still accepts it. First assert a
role-specific logged-in landmark (not merely absence of a login form), then act.
If redirected to login, challenged for MFA or denied permission, stop protected
actions and resume preparation with the user. Do not retry passwords, weaken
assertions, or report the protected flow as passed. Each job uses a fresh browser;
a login performed in one exploratory job is not automatically carried to another.

## Keep reports with the task

With `card`, terminal exploration archives published HTML and screenshots under
that card and registers report artifacts. Without a card it remains private until
you call `midscene_archive` with the intended card and runId. Ask which card only
when the task context cannot resolve it; never guess ownership for old runs.

## Interpret preparation diagnostics

Pass the current `card` to `midscene_doctor` when preparing task acceptance. Without
a card, project acceptance is not checked; do not report its suite or receipt as
missing. The doctor checks metadata and references only, not application reachability,
login validity, deployment receipt contents or visual correctness.

If completion checks are unavailable, inspect the `devflow-gates` plugin and its
`shell` dependency in the active DSH instance. Do not infer that the package is
uninstalled merely because its service is unavailable. Offer exploration only for
exploratory work; a task requiring formal acceptance stays blocked until its
completion checks and genuine acceptance inputs are ready.
