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

Call `midscene_browser` with optional `targetUrl`, action `prompt` and visual
`assertion`. Omit `profile` for project mode; an explicit legacy profile remains
available. Never include passwords or tokens in tool arguments.

Wait for the returned job using existing job tools. Read its output and inspect
saved screenshots before another operation. A started job is not success.
Summarize observations, attempted actions, assertions, failures and report links.
A screenshot-only run reports `observed`, not `passed`.

Project mode owns a fresh Chromium per job. Dependent page interactions belong
in one natural-language action. It does not borrow the user's Codex browser or
copy their login automatically. If authentication is missing, report it and use
the project's authorized login procedure; do not claim protected pages passed.
Legacy profiles can explicitly select dedicated CDP/Bridge sessions or private
login snapshots. Borrowed browsers stay open and require serial operations.

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
