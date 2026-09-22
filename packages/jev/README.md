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

## Configuration

This package takes none. Endpoint, model, credential reference, timeout, and retry policy are deployment choices owned by the provider, and thresholds are owned by each consumer.

## Known limitations

**No cross-session decision log.** A consumer's own tool result is the durable, replayable record of what was judged; this seam writes no file of its own. Comparing a judgement against what later turned out to be true therefore has to be done from session history rather than from a purpose-built log.

**No cordis events.** A scope-filtered event needs a routing entry in the harness's generated scope table, which a package outside the harness cannot add. Consumers observe judgements through their own results instead. An unscoped event remains available if a cross-plugin subscriber ever needs one.

**No provider registry.** One provider at a time, registered by being mounted. A second backend would want selection rules and an ambiguity error; adding them now would be an empty shell.

**No runtime invariant companion is published with a check.** The three contract relations all hold within a single `ask()` call stack and are asserted there, so an observer watching from outside would have nothing independent to compare.
