# Agent Note: Adapting the plugin line to harness 0.2.1-alpha.2

Status: implemented

## Problem

This line was pinned to `0.1.5-rc.2`. Four releases later the harness had
removed the runtime invariant registry, replaced one-shot delegation with
managed activations, partitioned message sources by role, moved session
navigation off `ctx.sessions`, made a Session own its working directory, and
turned a Job's owner into a `SessionId`. None of that is visible from a version
number, and a bump across it fails in two different ways at once: missing
modules the removal explains, and surface drift the semantic changes explain.
Mixed into one `tsc` output neither set is readable.

Two further facts shaped the work. `tsc -b` does not cover `packages/*/tests/`
([spec](../../../../.trellis/spec/dsh-devflow-plugins/verify-excludes-package-tests.md)),
so a green typecheck says nothing about the suites. And the harness's own
`@deprecated` and capability contracts are enforced by lint and at runtime
respectively, so "it compiles" was never the finish line.

## Decision

Bump in two commits, removal before version, then adapt by contract.

**Removal first, at the old version.** The 37 invariant companions came out
while still on `0.1.5-rc.2`, so the 37 missing-module errors never entered the
same `tsc` output as the real drift. Every error the bump then produced was a
genuine signal. The removal reached seventeen kinds of reference, of which a
first grep found nine; the largest — 74 dependency declarations — was invisible
to it. Two of the 37 held real checks, and the decision record for whether to
re-express them is deliberately left open
([research](../../../../.trellis/tasks/10-09-harness-021-dep-baseline/research/invariant-loss.md)):
upstream deleted the mechanism rather than absorbing those relations.

**Four write sites, not three.** `AGENTS.md` documented three places the harness
version is written. `cordis`, `schemastery`, `cordis-plugin-loader`, and
`cordis-plugin-include` live in the harness's `vendor/` and release on their own
cadence, so a global replace of the harness string leaves them behind. The rule
now says so.

**A plugin-owned Agent is entered, not registered.** `startActivation` requires
`ctx.agents.get(parent.id)` to be the exact object passed. `register()` is
itself an async effect, and effects added after the fiber starts never activate
— which is exactly when a gate creates its synthetic parent. `enter()` is the
synchronous primitive; disposal stays an effect because that is where the
convention earns something. The full measurement is its own
[spec](../../../../.trellis/spec/dsh-devflow-plugins/plugin-owned-live-agents.md).

**`delivery: 'caller'` for gate checkers.** The parent is a lineage anchor
nothing prompts or maintains, so a completion notice addressed to it would have
no reader and would sit in the inbox of an Agent that never runs.

**Each producer declares its own message source.** The generic
`{ kind: 'plugin' }` is gone and the new union has no catch-all. Iron rules
needed a *second* kind rather than reuse: its pre-step selects resident rule
messages by kind to decide whether the visible context holds the current digest,
and a notice counted among them is a rule publication that never happened. The
Midscene bridge got none of its own — its messages are a request payload for
`call.stream()` that never reaches a Session log, so the harness's role-matched
sources are the honest attribution, and because `SystemMessage` and
`AssistantMessage` each narrow `source`, role and source are now chosen together.

**One shared statement of the delegation dependency chain.** `ctx.subagents`
injects `workingDirectory`, which injects `fs`, `sessionProjections`, and
`systemPrompt`. Ten compositions had said it separately; `tests/subagent-composition.ts`
says it once, in both the `cordis.yml` and direct-mount shapes.

## What we gave up

**Two runtime checks.** `devflow/invariant` validated the notification streams
against the journal, and `devflow-parent-gate` was the net under its own gate: a
parent settled behind the gate's back failed there and nowhere else. They are
gone with the mechanism, and re-expressing them is a separate decision.

**One deprecated call stays.** `ruleHistory` still reads session history
synchronously, suppressed with its reason. Migrating it means designing a
durable projection that carries the resident baseline digest across resume —
which is what the upstream decision actually asks for, and is its own change
rather than a call-site rewrite.

**`pnpm exec` is unusable in this container.** It runs a deps-status check that
tries to purge `node_modules`. Every command in this work used
`./node_modules/.bin/<tool>` directly.

## Verification

`./node_modules/.bin/tsc -b --force` exits 0. `oxlint` exits 0. 2892 of 2894
tests pass. `test:coverage` reports no threshold violation.

The two failures are this container's, not the adaptation's: PID 1 is
`sleep infinity`, so nothing reaps children and 700 zombies are resident. Both
assert `processAlive(pid) === false` for a terminated browser and command, and a
zombie's PID still answers `kill(pid, 0)`. The suites also required
`chromium 1243` for playwright 1.63; the container had 1228.

Eight of the 26 upgrade guides between the two versions applied, two applied and
were deliberately not acted on, and sixteen did not apply — each with a written
reason ([sweep](../../../../.trellis/tasks/10-09-devflow-021-semantics/research/guide-sweep.md)).
Three specs recording measured `0.1.5-rc.2` contracts were re-checked;
`subagent-route-is-not-injectable.md` §4 changed conclusion — the fourth door is
now fully closed, because every backend that accepts a route is reached through
`prepareContinuable` and never through `start()`.
