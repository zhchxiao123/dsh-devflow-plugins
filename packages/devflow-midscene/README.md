# @zhchxiao123/dsh-devflow-midscene

English | [中文](README.zh.md)

An optional Web acceptance package. `devflow-midscene-browser` uses the pinned official CLI for exploration; `devflow-midscene-acceptance` runs approved suites, registers reports and requests completion gates. Loading the plugin starts no browser or model request. Install it separately from the default Devflow bundle.

## Current-project workflow

Install and load the plugin once, then ask the Harness agent to check the current project or accept its Devflow task. No global workspace profile is required. The agent uses `midscene_discover`, repository runbooks and existing shell/job tools to discover or start the application and verify its actual address. Static discovery reads conventional package scripts, explicit Vite ports and existing suites; it does not scan ports or itself start services. Ambiguous applications require a choice.

`midscene_project` remembers portable choices in `.devflow/midscene/settings.json`; users do not edit it manually. It accepts an application, target override or existing DSH model reference, never credentials. Otherwise the initiating session model is used. Known Midscene families are inferred; unknown aliases need a verified family. Metadata checks do not prove visual-action quality. Settings, suites and `validation.json` are deployment policy and belong in git; the package's lock file does not — [commit semantics of `.devflow`](../../docs/devflow.md#devflow-commit-semantics) is the authority for every path under that root.

A per-run authenticated loopback bridge sends screenshots and requests through published DSH LLM/attachment services. Provider secrets stay in DSH. Provider/model selection is fixed for the run; each request binds its own prepared adapter call. The public API cannot pin one connection generation across the entire run. Midscene prompts and parsing enforce structured responses without transport JSON mode. Resized attachments are rejected to preserve coordinate fidelity.

Use `midscene_browser` for exploration. Use `midscene_bind` to bind an actual task, reviewed suite and existing private deployment receipt, then `midscene_run`. The tool computes hashes and requests approval for a changed binding. Candidate suites can live under `.devflow/midscene/suites/`. The gate engine reads automatically written `.devflow/validation.json`; a missing Midscene provider still blocks required completion. The engine must be mounted before binding. The first receipt comes from the actual deployment workflow, not a copied remote build id.

Project runs attach reports through Devflow. Reports use authenticated relative Harness URLs without a report-host setting. Private runtime data is scoped by canonical workspace under Harness home; worktrees are isolated. History and cleanup do not require rediscovering the current model or URL. User browser login is not copied automatically; follow the authorized project login procedure. Explicit legacy profiles support private login snapshots.

`midscene_project` with `migrateProfile` copies safe choices from a matching legacy profile. Project settings take precedence for default selection. Explicit legacy profiles, global YAML and historical reports remain available. A crashed settings operation may leave `operation.lock` in this workspace's private runtime directory under Harness home; verify its recorded process has exited before removing that exact lock. A lock left under `.devflow/midscene/` by an earlier version records a process of the host that wrote it, is no longer read, and can be deleted. Filesystem checks do not constitute a kernel sandbox against hostile same-user directory races.

Formal project binding requires a JSON build probe with `field` and `instanceField`; a text-only marker cannot detect a same-build restart and is rejected before approval. Optional project `limits` control timeout, cleanup timeout and step count without editing global profiles.

## Legacy workspace profiles

The name `project` is reserved for automatic project context. Configure other named legacy workspace profiles on the plugin. Credentials are references to Harness's public credential service, never literal keys:

```yaml
profiles:
  local:
    workspace: /absolute/project
    output: /absolute/acceptance-results
    targetUrl: http://127.0.0.1:3082
    reportBaseUrl: http://127.0.0.1:3082
    provider: openai
    model: glm-5.3-flash:cloud
    family: gpt-5
    baseUrl: http://localhost:11434/v1
    credentialRef: OPENAI_API_KEY
    browserMode: puppeteer
    storageState: /private/path/login.json
    suite: e2e/acceptance.json
    suiteSha256: <approved suite SHA256>
    buildId: <deployment receipt buildId>
    deploymentRecord: /private/path/deployment.json
    timeoutMs: 180000
    cleanupTimeoutMs: 10000
    maxSteps: 30
```

`credentialRecord` may replace `credentialRef` to read a public `scope/id` API-key record; grants are not interpreted. Model settings and credentials resolve per operation without changing the host environment. `provider` queries published capability metadata; endpoint and supported Midscene family remain explicit. Exploration can run without a suite or build receipt; formal acceptance cannot.

Call `midscene_doctor`, then `midscene_browser` with optional action `prompt` and visual `assertion`, or `midscene_run` with card/profile. Both execution tools return existing owner-scoped Harness jobs. Wait and read screenshots before the next operation; use job tools to cancel. `midscene_inspect` reads historical runs after restart and treats unfinished exploration as unknown, never replaying actions.

Default mode creates a dedicated Chromium for each job and connects the official CLI through CDP. Its temporary files are isolated. Borrowed `browserMode: cdp` requires `cdpEndpoint`; `browserMode: bridge` requires the Chrome extension. Select a dedicated test tab first: the configured target can replace the active tab. These modes do not automatically connect to Codex's embedded browser. Cleanup stops the run's proxy and disconnects borrowed Chrome without closing it. Login snapshots apply to owned browsers only.

Enable the actual devflow-gates plugin and configure required validators:

```yaml
requiredValidators:
  - root: /absolute/project/.devflow
    edges: [testing->done, reviewing->done, developing->done]
    validators: [midscene:local]
    timeoutMs: 180000
```

Optional `cards` restricts the policy to particular cards. Missing validators, cancellation and failed acceptance refuse completion. A human/unowned call cannot impersonate an agent owner. Each gate reruns the approved suite; old passed reports and LLM approval do not override mechanical failure. Maintainers approve suite hashes and deployment policy; agents must not weaken them to bypass failures.

Configure devflow-web `acceptanceReports: [{workspace: /absolute/project, output: /absolute/acceptance-results}]` to expose session-scoped report links in job results. HTML is sandboxed; browser profiles, cookies and endpoint files are excluded. Without reportBaseUrl, links remain local files instead of guessing that the tested app is the Harness host. The [official Skill reference](assets/official-browser/PROVENANCE.md) includes its exact commit and license; execution never installs floating versions.

## Standalone CLI: install and prepare

Install the package in the project that owns the acceptance suite; use that project's package scripts to invoke the local CLI. Pin its version. Install the same package into a Harness profile to make the skill discoverable:

```sh
dsh plugin --profile acceptance add @zhchxiao123/dsh-devflow-midscene
pnpm add -D @zhchxiao123/dsh-devflow-midscene@0.4.0-dev.7 playwright@1.63.0
pnpm approve-builds # select sharp if pnpm reports its build script was blocked
pnpm exec playwright install chromium
```

For an unreleased build, use its locally packed tarball in both places. Managed execution uses published tools/jobs/credentials services. The SDK is pinned to Midscene `1.12.6` and Playwright `1.63.0`; use Node `24.18.0` for this repository. CI installs matching Chromium before keyless SDK integration tests. Linux may require `playwright install --with-deps chromium`.

Prepare the application's startup/check/shutdown runbook. Copy [the suite template](assets/suite.example.json), replace its target, probe and outcomes, and version it. Build probes accept plain-text GET or POST JSON, for example `{"path":"/devflow/api/build-info","expected":"<buildId>","method":"POST","format":"json","field":["value","buildId"],"instanceField":["value","instanceId"]}`. The response must match the deployment receipt; a supplied id alone is not evidence.

Devflow requires devflow-web `buildClient: {artifact: "/absolute/installed/devflow-ui/lib/client.js", entry: "@zhchxiao123/dsh-devflow-ui"}`. The served client URL comes from the live client-module graph. The server hashes its loaded web bundle and the configured UI artifact; workers also verify the actual served client bytes. Source execution, missing files and changes after activation are unavailable. Deployment tooling creates a private `{version:1,commit,workspaceSha256,buildId}` receipt from local built artifacts, never by copying a remote probe's value. This buildId covers the web channel and UI bundle; the deployment inventory separately records all installed package hashes.

CLI options `--storage-state /private/login.json` and `--deployment-record /private/deployment.json` require external files with owner-only POSIX permissions. Login snapshots contain only the target's cookies/localStorage and apply to both probes and isolated cases. Managed formal runs require a receipt and approved suite hash.

Configure `MIDSCENE_MODEL_BASE_URL`, `MIDSCENE_MODEL_API_KEY`, `MIDSCENE_MODEL_NAME`, and the model family's settings outside arguments. Use an endpoint supported by Midscene. The CLI does not obtain model credentials from Harness's `ctx.llm`. Do not store credentials in suites or URLs.

## Standalone CLI: run and inspect

Choose a persistent writable output directory **outside** the Git workspace, so writing evidence cannot change the fingerprinted inputs. The workspace must be a Git root with a commit; dirty and untracked source files are included in its fingerprint. Every run gets a unique child directory.

```sh
pnpm exec dsh-midscene run \
  --suite ./e2e/acceptance.json --workspace "$PWD" \
  --output /absolute/path/to/acceptance-results \
  --card 0001-midscene-acceptance --build-id tested-build-id \
  --model "$MIDSCENE_MODEL_NAME" \
  --timeout-ms 120000 --max-steps 30 --cleanup-timeout-ms 5000

pnpm exec dsh-midscene inspect --run /absolute/path/to/acceptance-results/run-id
```

`--browser-executable-path` selects an explicitly supplied Chromium executable. Prefer Playwright’s matching browser. Standalone CLI `--report-base-url` names a server serving the output root and appends the run id. It differs from managed profile `reportBaseUrl`, which uses authenticated Harness report routes. Without either option, links use local file URLs. The standalone runner and inspect validate the actual linked bytes; unavailable servers or fallback pages make evidence unavailable. Inspect accepts `--timeout-ms` for this check.

The JSON suite has `version: 1`, `name`, `baseUrl`, `buildProbe: {path, expected}`, and nonempty `cases`, each with unique `id` and nonempty `steps`. Supported steps are `goto` (`path`), `act` (`prompt`), `assert` (`prompt`), and deterministic `text` (`selector`, `expected`). A suite requires a visual assertion. Explicit navigation and build probes stay on the declared origin. `--max-steps` bounds the suite and each autonomous action's replanning cycles; `--timeout-ms` bounds wall time. These limits are not a currency budget.

Use the Harness shell's background option for long runs and its job read/kill tools for control. SIGINT/SIGTERM request shutdown; hard termination follows the configured cleanup deadline. Cleanup that cannot be confirmed is never called confirmed. A completed CLI returns zero only for a complete passing result with required reports; failure, missing configuration, partial execution, timeout and cancellation return nonzero.

## Evidence and Devflow

Each run records its manifest, finite case results, Markdown summary, report index, and available SDK HTML/screenshots. The manifest carries source/workspace/suite identity, verified target build, SDK/model, counts, timing, result and cleanup status. Available model token usage is separate from Harness accounting; missing measurements remain unavailable. HTML and screenshots can contain test data and must be retained according to the project's test-data policy.

Read the generated `test-report.md`, reread the card revision, and use `devflow_attach_artifact` with `kind: test-report` and `content`. Do not pass the external HTML path as a card-relative artifact. The store remains the only write path into protected card state. A missing report is unavailable evidence, including after moving or deleting its output directory.

Configure an applicable completion edge to **run** the project acceptance command again. Never use `inspect` as a cached-pass gate. Keep the gate's run id distinct from the earlier check. The command gate cannot register an artifact against the card while its transition is in progress; inspect and register failures through ordinary tool calls afterward. Explicitly choose policies for express/emergency shortcuts and parent integration acceptance.

`inspect` is read-only. A nonterminal record is unknown after the original process is lost; it is never inferred to have passed and is not resumed. Inspect the target before deliberately repeating any action with side effects. Completed evidence survives process exit, but the package does not promise cross-restart job execution, card-managed HTML attachments, a report server, native UI action tools, or mobile targets.

## Verification

Tests exercise the real SDK and Chromium against a controlled model transport, plus real Loader/skill and shell/tool/Devflow gate compositions. Controlled responses establish parser and lifecycle behavior, **not** visual-model accuracy. M1 additionally requires actual visual-model runs and the intended Devflow UI/profile; those results must be recorded separately from build and keyless tests.

### Authenticated deployments

`run` accepts `--storage-state PRIVATE_FILE` and `--deployment-record PRIVATE_FILE`.
Both are external, owner-readable-only JSON files; login snapshots are restricted to the suite origin.
Each case and the before/after build probes start from the same snapshot. Cookies and local storage are never written into the manifest.
A deployment receipt has `{ "version": 1, "commit": "...", "workspaceSha256": "...", "buildId": "..." }`.
Generate it during deployment from the source fingerprint and **local built artifact bytes**, not by copying an HTTP probe's answer.
The managed required gate must require the receipt; standalone legacy text probes remain supported.

For Devflow's authenticated endpoint use:

```json
"buildProbe": {
  "path": "/devflow/api/build-info",
  "expected": "BUILD_ID_FROM_DEPLOYMENT_RECEIPT",
  "method": "POST",
  "format": "json",
  "field": ["value", "buildId"],
  "instanceField": ["value", "instanceId"]
}
```

The runner checks the actual served client bundle bytes as well as the build identifier.
A build change or process restart during a suite prevents passing. Missing build artifacts remain unavailable.

Use `midscene_recover` to inspect and clean up an interrupted exploration after its owner process has exited. Recovery verifies process ownership and never replays browser actions; uncertain ownership stays unavailable.

If the host dies during official CLI exploration, use the session-scoped `midscene_recover` tool after restarting.
It refuses recovery while the original host PID is alive, validates private process ownership, and stops the recorded
CLI command, CDP proxy and owned Chromium without replaying UI operations. Evidence becomes `interrupted`;
uncertain ownership remains `cleanup: unknown`. Borrowed Chrome is never killed. Bridge sessions without verifiable
process ownership remain unknown and need their normal disconnect workflow.

The local `glm-5.3-flash:cloud` endpoint returned pixel coordinates and passed panel navigation plus visual assertion with the `gpt-5` protocol adapter. `family` selects Midscene protocol and coordinate conventions; do not infer it from a brand name. This is a local compatibility result, not an official model certification. Borrowed CDP/Bridge mode requires a dedicated test Chrome instance because the CLI can navigate its current tab.

### Reading SDK reports inside the authenticated sandbox

Published SDK HTML installs per-document, memory-only `localStorage` and `sessionStorage` before the SDK UI starts. This keeps the report readable under `sandbox allow-scripts` without granting `allow-same-origin`, host cookies, or host storage access. Report preferences last only until reload. Formal reports are published as `case-N.html`; exploration reports are copied to `reports/`, while the SDK originals remain outside the served artifact list. The HTTP route serves the published file unchanged. Tests load real SDK reports in Chromium under the production CSP, assert visible assertion content and no page errors, and verify host storage is unchanged.

## Login preparation and card reports

`devflow-workflow` routes the agent to the existing browser/acceptance skills. The agent discovers the environment and asks only for missing test roles, login route, test data and allowed actions. Users complete SSO/MFA in a dedicated browser; passwords never belong in conversations, action prompts or cards.

Remember non-secret `authentication: {required: true, role: "reader"}` with `midscene_project`; import an authorized, owner-only Playwright storageState file outside the repository using `midscene_auth`. Snapshots are scoped by project, origin and role and reused by formal runs and completion gates. Missing or locally expired snapshots block login-required runs; server revocation and incorrect roles require a logged-in landmark check and renewed preparation, never a passing business result.

Report copies live under the card's `artifacts/midscene/<runId>/`, including HTML and published screenshots; private runtime files and login snapshots stay outside the project. Use `midscene_archive` to attach an existing exploration run to a card. Reports can contain page business data; use authorized test data.
