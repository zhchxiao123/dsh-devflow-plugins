# Agent Note: env_test, not integration_test

Status: implemented

## Problem

The testenv engine never encoded "integration". `executeRun` knows three phases —
up, seed, test — and nothing below the tool surface asks what layer the test
command belongs to. The word lived in exactly three places: the tool name, the
prose, and the bootstrap skill's selection protocol.

That protocol never excluded end-to-end suites either. It selects "the suite whose
verdict depends on the running services" — a service-binding criterion, not a
layer one — so a browser suite bound to a live stack was always a legal choice.

The name was therefore the only thing claiming a scope the executor does not have,
and it claimed it to the one reader who cannot check: a model choosing which tool
to reach for reads the name first and the description second. `integration_test`
tells it the tool is for integration suites, so a model working on an end-to-end
failure has no reason to open the description that would have corrected it. A
wrong prior costs more than no prior.

## Decision

The tool is `env_test`, joining `env_up` / `env_status` / `env_logs` / `env_down`.
The background job kind is `testenv-test` with the label `test run`, the
verdict-first render reads `Test run passed …` / `Test run failed …`, and the
exported report type is `TestRunReport`. The environment the four lifecycle tools
manage is a "test environment" throughout, not an "integration-test environment".

No alias for the old name.

### Why the env_ family rather than another neutral word

Joining the family buys three things a standalone neutral name does not. It is
scope-neutral without being empty — `env_test` says the one fact that matters,
that this test needs the environment the other four manage. It ends an existing
naming anomaly: the fifth tool was the only one outside the family. And it leaves
`env_test(target)` available as the shape for the deferred multi-target work,
which is the direction the manifest's single `test` field already blocks.

## Alternatives considered

**`final_test`.** Taxonomy-neutral, and free of the wrong prior. Rejected because
"final" is a lifecycle word that asserts singularity — there is one final test —
immediately before the manifest is meant to grow plural named targets. It also
carries a sequencing claim ("run this last") that the plugin neither makes nor
enforces, and a finality claim that sits badly against a plugin which explicitly
refuses failure attribution.

**Keeping `integration_test`, carrying the correction in the description.** The
description is read after the name has already filtered which tools the model
considers. A correction placed behind that filter does not reach the reader who
needs it.

**`e2e_test`.** Trades one wrong prior for another, and would be wrong again the
moment the tool serves a contract suite.

## Consequences

The rename is breaking and model-visible, and it ships without an alias. That is
affordable exactly once: the package is at `0.4.0-dev.7` with no published
downstream consumer, and the same change after 1.0 costs a deprecation cycle.
Deferring it would have meant paying that cycle for a name already known wrong.

A model carrying `integration_test` from an older session now gets an unknown-tool
error rather than a redirect. Accepted: a silent alias would leave the wrong prior
in place, which is the thing the rename exists to remove.

The `testenv-author` skill still describes deriving an "integration-test plan" and
writing "integration tests". That text is about which tests to write, not about
what the executor runs, and it moves with the end-to-end survey work rather than
with this rename.
