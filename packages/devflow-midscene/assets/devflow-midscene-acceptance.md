# Midscene task acceptance

Harness Agent executes this workflow. Devflow owns task state and journal
history; Midscene supplies browser evidence and a mechanical completion check.

## Prepare the task and target

1. Read the current task, revision and acceptance criteria. If no task is selected,
   resolve it through Devflow; ask only when multiple tasks remain plausible.
2. Use `devflow-midscene-browser` to discover and prepare the target with existing
   Harness tools. Verify the actual URL, application and deployed build.
3. Discover existing acceptance suites and deployment receipts from the project's
   deployment runbook and previous task artifacts. Map all task criteria to cases.
   Generate a candidate suite only when necessary; do not weaken failing cases.
   A build receipt must come from the real deployment process and source/artifact
   identity. Copying a remote build id into a newly invented receipt is not proof.
4. Call `midscene_bind` with the task and an existing project-relative `suite` or
   candidate `suiteJson`. Supply an existing private `deploymentRecord` for the
   first binding; subsequent bindings can reuse the project's copied receipt.
   The tool calculates hashes, presents a changed suite for one-shot approval,
   and stores approved choices under `.devflow`. No user should hand-edit hashes,
   machine paths, model keys or global profile YAML.

The Devflow gate engine must be mounted. Binding persists the requirement in
`.devflow/validation.json` before publishing the suite settings. An interrupted
binding can therefore block completion until repaired; it cannot silently remove
the requirement. An unchanged binding reuses approval. Changes to task revision,
source, suite or settings during approval require another attempt.

The source deployment must expose the suite's build probe. If no trustworthy
receipt/probe is available, report formal acceptance unavailable and continue
only explicitly requested exploration. A first-time receipt is not synthesized
by the Midscene plugin.

Completion requires a JSON build probe with both a build field and an
`instanceField` that identifies the running instance. A text-only build marker
is insufficient for final restart detection and is rejected by the binding tool.

## Execute and register

Call `midscene_run` with the task id. The tool reuses the initiating DSH model and
starts an owner-scoped job. Use existing job tools to follow progress or cancel.
A formal run archives published HTML and screenshots under the card’s
`artifacts/midscene/<runId>/` and registers Markdown and HTML using the real Devflow
artifact API. On a revision conflict, inspect the saved run and current task;
do not blindly retry an attachment. Failed runs are still useful evidence.

Read case/assertion counts, screenshots, report links and cleanup status.
Distinguish assertion failure, infrastructure failure, timeout, cancellation,
interruption and incomplete execution. Source/suite/build/model identity must
match the work under review. A report alone does not authorize completion.

`midscene_inspect` reads history after restart without needing rediscovery.
`midscene_recover` only cleans identified resources; never automatically replay
an action that may have submitted or deleted data.

## Request the existing gates

Request the normal Devflow transition. The project requirement invokes
`midscene:project` for the bound task on completion edges, including express and
emergency shortcuts. The validator performs fresh execution and checks freshness
again before commit. A missing provider, failed cleanup or changed evidence blocks
completion. Parent tasks retain their existing parent gate and integration needs.

Do not attach artifacts inside the transition waterfall: the task store serializes
that transition. Gate records remain associated with their run and job, and may
be registered later through a normal artifact operation when applicable.

## Compatibility and recovery

Explicit legacy profiles and the standalone CLI remain supported by the package
README. `midscene_project` can migrate one matching legacy profile's safe project
choices; it does not delete global settings or approve legacy suites implicitly.

Project setting mutations use `.devflow/midscene/operation.lock`. If a host crash
leaves it behind, verify the recorded owner has exited before removing that exact
lock through an authorized recovery operation. Never delete a live owner's lock
or wipe `.devflow` to make acceptance pass.

## Authentication and user cooperation

Follow the browser skill's access-preparation flow before binding protected cases.
Confirm the required role/tenant, test data and allowed side effects with the user
only when the project cannot supply them. The user may need to log in or complete
MFA; they should not edit global profile YAML, paste passwords into chat, or author
storageState JSON. Import authorized target-scoped state using `midscene_auth`.

Each protected case must begin with navigation and an assertion of the expected
logged-in role before any business action. All cases and the fresh completion gate
use the project's private snapshot in fresh browsers. Expired server sessions must
return to login preparation; changing an approved suite still requires normal
binding approval. Login availability alone never proves business acceptance.

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
