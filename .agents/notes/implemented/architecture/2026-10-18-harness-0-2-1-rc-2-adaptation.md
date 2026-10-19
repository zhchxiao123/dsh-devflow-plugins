# Agent Note: Adapting the plugin line to harness 0.2.1-rc.2

Status: implemented

## Problem

Nine hundred and ninety commits separate `0.2.1-alpha.2` from `0.2.1-rc.2`, and
they brought twelve new upgrade guides. Reading the guides first is the right
order — it is how the last two adaptations found what to look for — but this
time the sweep came back empty: ten guides name surfaces this line has none of
(DeepSeek accounts, pi-ai, Desktop, non-page Clients, the plugin CLI,
`sdk-minimal`, credential stores), and the two that looked relevant were not.

An empty sweep is the dangerous shape. It reads like "nothing to do" while
saying only "nothing was written down", and 990 commits do not pass without
moving surface this line stands on.

## Decision

Treat the empty sweep as a reason to run the gates, not to skip them: bump the
pin, then let `tsc -b --force` and the suite name what moved. Three things had.

**Tool scoping left the start request.** `SubagentCapabilities` dropped
`toolFilter` and `persona` and gained `agentPreset`; `toolFilter` is gone from
`SubagentStartRequest` itself. That distinction decided the change: an ungated
option would have meant deleting a capability check and keeping the filter, but
there is no filter to keep. Both gates negotiated it, so both lose per-dispatch
tool scoping, and what remains is the checker prompt's verdict contract — the
trade-off their READMEs already documented for providers that rejected the
capability, now the only behavior. `agentPreset` is the replacement, but it
names a whole composition rather than a deny list, so adopting it means a
deployment-configured checker preset, which is a change with its own contract.
`CHECKER_DENIED_TOOLS` went with the call site: a record no caller reads is
surface this line would have to keep.

**A Job's id became `<kind>-<short-uuid>`.** Two specs predicted `midscene-1`.
A third thing was worse than those two: `CapturingJobs` minted sequence numbers
of its own, so it kept passing while agreeing with nothing the registry does.
The double now mints the real shape, which is why a spec cannot quietly depend
on a counter again.

**The jsonl session-persistence plugin became a named function plugin.** It was
a default-exported service class; a default import now yields `undefined` and
cordis refuses it. Twenty of the thirty-seven failures were that one line in a
shared test helper.

## What we gave up

**Per-dispatch tool scoping for checkers.** A checker can no longer be
prevented, at dispatch, from holding `write`, `edit`, or the devflow mutation
tools. Before this release the same was already true for every provider that
rejected the `toolFilter` capability — `acp`, `codex`, `claude-code` — so the
gates' prompt contract already carried the obligation for the common case. It
now carries it for all of them. Restoring a mechanical guarantee means adopting
`agentPreset`, and both gates would have to do it together with a preset the
deployment configures.

## Verification

`tsc -b --force` exits 0, `oxlint` exits 0, 2573 of 2575 tests pass. The two
failures are this container's: PID 1 is `sleep infinity` with 200 zombies
resident, so a terminated browser's exit cannot be confirmed and both cases
report process identity rather than behavior. Ten further midscene failures
during the work were also environmental — the container had lost the
`chromium 1243` build that playwright 1.63 needs — and went away once it was
reinstalled, which is worth separating from the three real changes above.

Four `vendor/` packages left prerelease in this window while the harness stayed
on one: `cordis 4.0.5`, `schemastery 3.18.5`, `cordis-plugin-loader 1.0.6`,
`cordis-plugin-include 1.0.10`. That is exactly the drift the fourth write site
exists to catch, and a global replace of the harness string would have left all
four behind.

Four specs carrying measured contracts were re-checked rather than re-dated.
Three were confirmed against the published bundle: the exact-live-parent throw
and `enter()` in `plugin-owned-live-agents.md`, the two-call executor in
`running-an-external-cli.md`, and the dispatch split in
`subagent-route-is-not-injectable.md` §4. The fourth,
`turn-stopping-window.md`, is a behavioural contract that no declaration can
confirm — what confirms it is the 244 green cases in `devflow-iron-rules` and
`devflow-spec-sentinel`, and the index now says so instead of implying a
reading.
