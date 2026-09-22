# Agent Note: The Jev Provider Uses the Vendor SDK, Because It Has No Transport

Status: implemented

## Problem

This line reaches the network through the global `fetch` and nothing else — no
undici, no axios, no `node:http`, and no proxy-environment handling anywhere.
That is not an aesthetic preference. The harness resolves one outbound proxy
policy at launch and installs it as undici's **global dispatcher**, which is
what `fetch` resolves; a client that carries its own transport connects around
that policy without saying so. In a deployment whose egress is forced through a
relay, that is the difference between a judgement that works and one that fails
in a way nobody can see.

So the question for the Jev provider was not "SDK or hand-written HTTP" in the
abstract. It was whether `@typesafe-ai/sdk` is a client or a transport.

## Decision

It is a client. `@typesafe-ai/sdk@0.6.0` declares `dependencies: {}` and
`peerDependencies: {}`, and its published `dist/index.{mjs,cjs}` — 28 KB, the
whole of it — contains **zero non-relative imports**, not even a `node:`
builtin. Every request goes through `globalThis.fetch`. The proxy policy
therefore applies to judgements exactly as it applies to everything else, and
`packages/jev-typesafe` depends on the SDK at an exact pin.

What that buys, beyond not writing it: retry with jittered backoff,
`retry-after` honoured on a rate refusal, a per-attempt deadline, and one error
class per failure — which is what makes `wire.ts`'s classification a table of
`instanceof` rather than a pile of status-code arithmetic. The seam's eight
failure codes each map from exactly one SDK type.

The SDK's `fetch` option is the test seam. `TypeSafeJev.createClient` is
`protected` so a spec subclasses it and supplies a scripted transport; a `fetch`
field on `Config` would have been a test hook wearing a deployment choice's
clothes.

The client is built per call. The SDK takes the API key at construction and the
credential seam's contract is that consumers re-resolve per operation, so a
retained client would pin whichever key was current when the plugin loaded — the
exact failure the reference-based seam exists to prevent.

## Alternatives considered

**Hand-written `fetch`**, on the model of `github-sync-local/src/github.ts`.
This was the fallback if the probe had found a bundled transport, and it stays
viable: the wire translation and the failure classification are already separate
from the call. Rejected because it would mean re-implementing a correct retry
loop — `retry-after` in both seconds and HTTP-date form, backoff, jitter, a
cancellation check before each sleep — to get something already shipped and
tested by the vendor.

**Trusting the documentation that the SDK is dependency-free.** Rejected on the
same reasoning this repo already wrote down for external CLIs: vendor prose and
vendor programs disagree, and three of the four disagreements found last time
produced silently wrong behaviour rather than an error. The claim was checked
against the published tarball.

**Using the SDK's typed question builders** (`score()`, `choice()`, `noul()`),
which infer answer types from literal criteria. Rejected because this provider's
questions are built at runtime from a consumer's configuration, so there are no
literal types to infer from; the inference would buy nothing and the builders
would add a translation step.

## Consequences

Compiling against the real declarations — rather than against the API
documentation — moved two things in the seam, both tightenings:

- **A score rubric needs at least two levels, not one.** The vendor's
  `ScoreCriteria` is `[EntryType, EntryType, ...EntryType[]]`, and the reason
  survives the vendor: a one-level rubric has nothing to discriminate, so every
  answer is that level and the question carries no information.
- **`Description` excludes bare numbers and booleans.** Evidence, instructions,
  and level descriptions are things a reader reads. A caller with a number wraps
  it in a named field, which is what it should have done anyway.

Both were found by the compiler on the first build of this package, which is the
argument for building the provider against real types early rather than treating
the seam as finished when its own specs pass.

The cost is a version to track: the SDK is pre-1.0 and ships a migration guide,
so the dependency is pinned exactly rather than caret-ranged, and a bump is a
deliberate change.

## Testing

`tests/wire.spec.ts` covers translation and classification as pure functions.
`tests/provider.spec.ts` runs the real SDK against a scripted `fetch`: each
failure mapping, the credential re-read across two calls, and an answer that
will not decode leaving its key absent. `tests/typesafe.e2e.ts` is the only test
that opens a socket and is excluded from collection by its extension.

## Deferred

The response fixtures are built from the vendor's type declarations rather than
captured from a live call; `tests/fixtures/README.md` states that and names what
it leaves uncovered. Replacing them with real captures is the first thing the
e2e run is for.
