# Agent Note: A Typed-Judgement Seam, Named After Its First Backend

Status: implemented

## Problem

Agentic coding spends a frontier model on judgements that are cheap and
mechanical: whether a changed file is worth an expert's review, whether a turn
needs a particular skill loaded, whether a tool call is the dangerous kind. Each
of those is answered today as a side effect of the coding model's own reasoning,
which makes them slow, expensive, and — the part that actually hurts —
uncalibrated. There is no number to threshold, so there is nothing to tune and
nothing to audit.

The usual workaround is a prompt asking an LLM to "return JSON", then a parser
that hopes. That parser is the defect: it turns every model wobble into a
runtime shape error, and it gives code no way to say *how sure* the answer was.

A separate class of model answers this directly. Given one body of evidence and
a set of typed questions, it returns typed answers with calibrated probabilities
and never generates text. That is a capability this line did not have.

## Decision

`ctx.jev` is a capability seam in `packages/jev`, published as
`@zhchxiao123/dsh-jev`. It defines the vocabulary — a **State** is the evidence
one call evaluates, a **Question** is one typed judgement asked against it
(Choice, Score, or Noul), an **Answer** carries the verdict with the
distribution behind it — and `ask(request, signal)`. It holds no transport and
knows no vendor.

`JevRuntime` is abstract. `ask()` is concrete and `perform()` is the protected
abstract a provider implements, so three contract relations live in the base
class rather than in each provider:

- answers are projected onto the keys that were asked, dropping extras;
- a question that went unanswered stays **absent**, never zero-filled, because
  "judged at the bottom of the rubric" and "not judged" are different facts;
- failure throws `JevError` with a `code`.

The third is the load-bearing one. Whether an unavailable judgement should fail
open or fail closed belongs to the consumer: a triage tool that reviews
everything when it cannot judge is safe, and an approval consumer making the
same choice is not. A transport that swallowed its own failures would settle
that question for every future consumer at once.

`JEV_ABORTED` is cancellation and not an unavailable judgement. A consumer must
re-raise it; a withdrawn call that reports a full set of conservative results
looks like it succeeded.

Requests whose shape is already unanswerable — no questions, unknown type, a
Score with no levels, a Choice with none or more than 255 options — are rejected
as `JEV_INVALID_REQUEST` before a provider spends a call. `assertRequest` takes
`unknown` rather than `JevRequest`: typing it as the target would make every
guard look redundant to the linter while leaving the real hole open.

The name carries the first backend. `jev`, `ctx.jev`, `JevRuntime`, `JEV_*`.
This is deliberate and it is the one place the seam is not vendor-neutral: the
*contract* stays swappable and a consumer never names a provider, but the
*label* is anchored to a model that exists today, because that is the word
someone searching for this capability will type.

## Alternatives considered

**One package instead of three.** The seam, a provider, and a consumer could
share a directory. Rejected on testing: this line requires per-file 100%
coverage and offline-runnable suites, so HTTP inside the seam would force every
future consumer's specs to fabricate a `fetch`. With the provider separate, a
consumer mounts a twenty-line in-memory subclass. The cost — three sets of the
seven registrations a new package needs — is real and accepted.

**A provider registry**, in the shape of `ctx.web`'s `registerSearchProvider`.
Rejected as an empty shell: with one backend, the selection rules and the
ambiguity error have nothing to arbitrate. Adding a registry later changes the
seam's internals and no consumer.

**A cordis event carrying each decision.** Rejected because a scope-filtered
event needs a routing entry in the harness's generated scope table, which a
package outside the harness cannot add. Consumers observe judgements through
their own tool results, which are already durable and replayable. An unscoped
event remains available if a cross-plugin subscriber ever appears.

**A decision log file** under the repository being judged, as the prior art
does. Rejected: this line has `devflow-fs-guard` precisely because writing into
a user's tree from a plugin is a thing we constrain, and a general-purpose
capability package should not be what opens that door.

**`ctx.judge`, vendor-neutral throughout.** Rejected by the same reasoning that
chose the name: accurate and unmemorable. The trade is recorded under
Consequences.

## Consequences

The seam costs one more package than the capability strictly needs, and the
three-package split multiplies the registration work by three — including the
`tsconfig.base.json` `paths` entry whose omission reports as a `package.json`
defect that is not one.

What it buys: a consumer can be tested against an in-memory judgement with no
network, no credentials, and no vendor package on its dependency list at all,
and that independence is mechanically checkable rather than merely intended.

The name will age badly if the backend is ever replaced — `dsh-jev` would then
describe a package that no longer talks to Jev. Nothing breaks when that
happens; the contract, the types, and every consumer keep working. What is lost
is only that the name stops being true, and renaming a published package is the
price of getting it back.

## Testing

`packages/jev/tests/` covers the contract at the seam: extras dropped,
unanswered questions absent, each invalid request shape rejected *without*
reaching `perform` (asserted through the double's call log), an already-aborted
signal raising before transport, a live signal reaching the provider, and
`ctx.jev` released with the fiber that provided it. `tests/memory.ts` is the
scripted double the provider-free consumers will reuse.

## Deferred

Model routing on `agent/request`, skill suggestion on `system-prompt/assemble`,
and automatic approval on `approval/request` are all consumers this seam makes
possible and none of them ship here. Approval in particular inverts the failure
direction — a wrong judgement there executes an action rather than wasting a
review — and wants shadow-mode data before it is armed.
