# Midscene Web acceptance

Use this procedure for a card's repeatable Web acceptance. The Harness agent
executes the workflow; the CLI owns one isolated browser run. It never advances
the card or writes protected Devflow state.

## Prepare the target and suite

1. Read the card, its current revision, and acceptance criteria. Map each
   criterion to an explicit case. Do not weaken an assertion to make a run pass.
2. Follow the project's E2E startup/check/shutdown runbook. Use
   `devflow-e2e-bootstrap-runbook` if one must first be established. Confirm the
   URL points at the intended build. A caller-supplied build id alone is not proof.
3. Install the optional package in the test project and pin its SDK/browser
   dependencies. Follow the package README for the versioned JSON suite and CLI
   arguments. Keep the suite under version control. Use an isolated test account.
4. Configure the visual model outside tool arguments. Never print API keys,
   tokens, storage state, or credential-bearing URLs. Missing configuration is
   unavailable acceptance, not a skipped successful test.

## Run and observe

For a managed Harness profile, run `midscene_doctor` then `midscene_run` with the
profile and card id. The host resolves its model credential and approved suite;
wait for the returned job and read its reports. No secret belongs in tool input.
Use `devflow-midscene-browser` for quick exploration without a build receipt.

Invoke `dsh-midscene run` using the documented suite, workspace, output directory,
card, build id, model, and timeout. Give every attempt its own run directory.
Use the Harness shell's background option for a long run; retain its job id.
Read progress through existing job tools. A started job is not a passed test.

Use `job_kill` to cancel a background run. Wait for the process and owned browser
to stop. For a foreground run, respect the invocation's cancellation signal.
Do not report cleanup complete merely because the request to cancel returned.

Use `dsh-midscene inspect --run <directory>` to read recorded output after a run
or a restart. A run without a trustworthy terminal result is interrupted or
unknown. Inspect the target before explicitly rerunning an action that might
already have submitted or deleted data. Never automatically replay such actions.

## Report and register

Read the actual run result, case and assertion counts, and generated report.
Distinguish assertion failure, infrastructure failure, cancellation, timeout,
partial/zero execution, and interruption. Only a complete passing run with its
required reports is a passing check. Verify code, dirty-workspace, suite, target
build, and model identity match the work being accepted.

Open the independent HTML report. Read the bounded Markdown summary rather than
putting the entire HTML or execution dump into model context. Missing reports
are unavailable evidence. Retain finished outputs until explicit cleanup.

Reread the card and invoke `devflow_attach_artifact` with `kind: test-report`,
the generated Markdown content, and the newly observed revision. The report includes card/kind/title frontmatter and Scope, Results and Conclusion
sections for the deployed artifact gate, plus coverage counts and independent HTML links.
An external output path is not a card-relative artifact path. Do not write
directly under protected `.devflow` directories.

On a revision conflict, reread the card and check whether the result still
applies; do not blindly replay the write. A blocked or completed card cannot
accept a new registration through this procedure.

## Request the existing gates

Ask Devflow to perform the normal transition. The required `midscene:<profile>`
validator runs fresh acceptance through the same managed core. The deployment
must enable devflow-gates and name this validator in its workspace-scoped policy;
merely loading Midscene or registering a test-report does not enforce acceptance.
For independent CLI deployments, the configured command gate runs
the suite again and decides using that attempt's actual exit and report state.
Keep this gate attempt distinct from the prior check. Cached `passed` fields
cannot authorize completion. For this reason, do not register artifacts inside a transition gate.
Gate output remains outside the card until an ordinary subsequent tool call can
register it without reentering the card's serialized transition.

Configure only applicable completion edges. Express and emergency shortcuts do
not traverse `testing->done`; if their edges have no visual check, say that no
Midscene acceptance was required, never that it passed. Parent cards still need
their own integration acceptance and the existing parent completion policy.

Exploring a page is not a complete acceptance suite. Capture useful exploration
as a reviewed case before it becomes an acceptance obligation. Native Web tools
and mobile/desktop targets are outside this phase-one procedure.
