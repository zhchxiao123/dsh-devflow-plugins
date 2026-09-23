# Typed judgement service

The `ctx.jev` definition supplies calibrated, typed judgements that code consumes directly: a caller hands over one **State** and a set of typed **Questions**, and gets back **Answers** carrying a verdict and the distribution behind it. Nothing here generates prose, and nothing here parses any. Load a provider such as `@zhchxiao123/dsh-jev-typesafe`; this package is the vocabulary and the contract, so a composition mounts the provider rather than this class.

A Question is one of three. A **Choice** picks one option from a defined set and returns the probability of each. A **Score** rates along ordered levels you describe, and returns a probability per level; the index of a level is its score, so the levels are what a score means. A **Noul** returns the probability that a condition holds — it carries no separate confidence, because a value near 0.5 says yes and no are near-equally likely, which is a statement about the question rather than a weaker version of one.

All questions in one call evaluate against the same State, independently of each other. Shared evidence belongs in the State; anything true of only one question belongs in that question's own `instructions`, which accept structure as well as prose. Question keys are addressing for your code and do not reach the judgement, so each question must carry its full meaning in its own fields.

## Contract

`ask(request, signal)` holds three guarantees on behalf of every provider, so that a provider getting one of them wrong cannot be wrong quietly.

**Answers are restricted to the keys that were asked.** A provider that returns more than it was asked has its extras dropped.

**An unanswered question stays absent.** It is never filled in with `null` or a zero, because a caller must always be able to tell "judged at the bottom of the rubric" from "not judged at all".

**Failure throws `JevError`, carrying a `code`.** Whether an unavailable judgement should fail open or fail closed is the consumer's policy — a triage tool that reviews everything when it cannot judge is safe, while an approval consumer making the same choice would not be. A transport that swallowed its own failures would take that decision away from every consumer at once. The codes separate a missing credential reference from an unreachable endpoint, a rate refusal, a malformed answer, and a withdrawn request, because those need different operator responses.

`JEV_ABORTED` is cancellation, not an unavailable judgement. A consumer must re-raise it rather than fold it into a fail-open branch; a withdrawn call that reports a full set of conservative results looks like it succeeded.

A request whose shape is already unanswerable — no questions, an unknown type, a Score with no levels, a Choice with no options or more than 255 — is rejected as `JEV_INVALID_REQUEST` before any provider spends a call on it.

## Generic runs

`JevRunEngine` executes a domain-neutral collection of typed checks. A run names its scope and template, while every check supplies its own subject, evidence digest, and `JevRequest`. The engine owns progress, cancellation, partial retry, provider-error capture, and orphan recovery; it has no knowledge of Devflow cards, GitHub issues, repositories, or schedulers.

`DurableJevRuns` adds atomic filesystem persistence through `FileJevRunStore`. The caller chooses the storage root, so a repository adapter, GitHub adapter, or scheduled automation can use the same run lifecycle. Adapters still own evidence collection and interpretation of typed answers.

## Workspace tools

Mount `@zhchxiao123/dsh-jev/runs-plugin` to expose three tools:

- `jev_run`: supply title/evidence/questions for a yes/no checklist, or definitionJson for a full typed run. Source defaults to generic. Installed adapters may accept other sources such as devflow-audit.
- `jev_list`: list all installed sources, optionally filter by source, or inspect one record by source/id. Results carry source, id, and the original record, including evidence on detail reads.
- `jev_control`: resume or cancel by source/id/action, under the live Harness job owner.

Example generic call:

```json
{"title":"API compatibility","evidence":"Observed diff and test evidence goes here","questions":["Does the public API preserve existing callers?","Do the tests cover the changed failure paths?"]}
```

The simple form supplies evidence; it does not scan files. Definitions, checkpoints and job bindings continue to live under the current workspace's `.jev`. Source adapters are registered through `ctx.jevRuns` with disposers; the generic package has no Devflow dependency. The old jev_start_run/jev_runs/jev_resume_run/jev_cancel_run registrations are retired. The specialized jev_triage tool is unchanged.

## Automatic usage guidance

When the runs plugin, a provider, and Harness system-prompt service are mounted, development sessions with a workspace receive JEV guidance if the provider reports a configured credential and the relevant tools are visible. The credential status is resolved during each prompt assembly, including the first; tool visibility is checked for the assembling agent. Missing credentials, unknown provider status, or missing capabilities suppress the guidance. Unloading the plugin removes its contribution.

The guidance asks the agent to gather evidence, use JEV for material uncertainty, risky changes, and delivery checks, and inspect or resume existing runs before starting duplicates. Trivial edits and unchanged evidence do not need another judgement. JEV conclusions are advisory: they cannot replace tests or authorize workflow transitions. Provider errors must remain visible. This is model guidance, not a deterministic scheduling guarantee; verify natural tool use in a fresh development session.

Providers may implement `configurationStatus()` to return `configured`, `unconfigured`, or `unknown`; the base implementation returns `unknown`. This reports local configuration only, without authenticating against the remote API or exposing credentials. The runs plugin owns this guidance; mounting only the triage tool does not enable it.

## Configuration

This package takes none. Endpoint, model, credential reference, timeout, and retry policy are deployment choices owned by the provider, and thresholds are owned by each consumer.

## Known limitations

**No global decision index.** Durable runs are stored below a caller-selected root. Cross-project discovery therefore belongs to a host UI or index adapter rather than this package.

**No cordis events.** A scope-filtered event needs a routing entry in the harness's generated scope table, which a package outside the harness cannot add. Consumers observe judgements through their own results instead. An unscoped event remains available if a cross-plugin subscriber ever needs one.

**No provider registry.** One provider at a time, registered by being mounted. A second backend would want selection rules and an ambiguity error; adding them now would be an empty shell.

**No runtime invariant companion is published with a check.** The three contract relations all hold within a single `ask()` call stack and are asserted there, so an observer watching from outside would have nothing independent to compare.
