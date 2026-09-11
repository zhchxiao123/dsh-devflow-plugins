# Agent Note: a failed run says what it left behind

Status: implemented

## Problem

A red `env_test` gave the model an exit code and a bounded in-memory tail of
stdout, and `env_logs` stopped answering at teardown.

For a contract suite that is enough, because stdout *is* the evidence — the
assertion diff and the stack trace are already in it. For an end-to-end suite
it is close to nothing. The decisive evidence there is files the runner wrote
to disk: the trace archive, the screenshot of the moment the assertion failed,
the video. What reaches the model instead is one line saying `1 failed:
login.spec.ts:12`, and no way to act on it except to go hunting.

The gap was never in the engine. `executeRun` knows up → seed → test and
nothing below the tool surface asks what layer the test belongs to, so the
plugin could always *run* an end-to-end suite. It could not let anyone
understand why one went red.

## Decision

The manifest declares where a red run leaves its evidence. `evidence` is one
glob or a list of them; `report` is the path and parser tag of a
machine-readable report of the run. Both are optional; a manifest declaring
neither behaves exactly as before.

After a red test phase — and only then — the tools expand the globs, read the
report, and report the failed cases with their positions, messages, and
pre-rendered source snippets, followed by the evidence files. Screenshots ride
along as image blocks the model can look at, bounded by quota; everything else
is a path.

### Declaring it is what makes it checkable

A declaration that matches nothing is reported as such. This is the whole
reason the globs live in the manifest instead of in prose: an output directory
renamed, or a reporter switched off, surfaces on the next red run. The same
knowledge written into a README rots silently and the agent follows it
confidently — which is the failure mode this line already names elsewhere.

### Minting happens in execute, not in render

`ToolOutputDefinition.render` is a pure synchronous function of the canonical
value, so a reference the model can look at has to exist in that value before
rendering starts. Saving an image is asynchronous IO, so it happens while the
tool executes and the reference is placed in the value.

The reference travels as plain JSON rather than as the attachment service's own
object. A canonical tool value must be lossless JSON; the service's reference
is an interface with a branded id and fields this plugin never reads. The
fields the render needs are copied across explicitly, and the one conversion
back sits at the content-block boundary.

### The engine stays ignorant of attachments

`EngineHost` still asks for `subprocess` and `effect` and nothing else.
Collection is engine-layer because it needs the manifest and the root, which
the engine already holds; minting is tool-layer because it is a question about
presentation. The engine's own suites need no attachment double.

### Degradation has no single reason, so it is given none

A file reaches the model as a path rather than an image when there is no
attachment service, when its media type is not one the service normalizes, when
it is past the size cap, when the inline quota is spent, or when the reader is a
background job whose output is text. An early draft emitted "no attachment
service is loaded" — which would have been a lie in four of those five cases.
The degradation is instead visible in the data: `image` present means the model
can see it, absent means it must read the path.

That optional service degrades where `ctx.jobs` fails loud, and the README says
why: a caller who asked for a background run is misled by a synchronous one,
while a caller reading a failure report loses nothing when an image arrives as
a path.

## Alternatives considered

**`finalizeContent` instead of minting in execute.** Its contract requires a
total, non-throwing, synchronous callback; saving an image is none of those.

**The engine returning content blocks directly.** It would put the `dsh-llm`
content model into `EngineHost`, fatten a seam whose narrowness is the reason
the engine is testable, and contradict the engine's role as an executor.

**Inventing an evidence vocabulary.** Unnecessary. Playwright reports
attachments as `{ name, path, contentType }` and the harness accepts images and
files keyed by media type; both ends already describe a named blob with a MIME
type and a path, so the plugin relays rather than translates.

**Writing evidence into devflow's `test-report` artifact.** That artifact is a
stage conclusion a person reads, not raw evidence, and reaching it would couple
`devflow-testenv` to the `ctx.devflow` seam it has never depended on.

**Shipping JUnit XML as a second format.** It is the cross-language interchange
format and the obvious next one, and it was cut. It carries less than the
`evidence` globs already deliver, it is a family of emitter dialects rather than
one schema, and no consumer asks for it — so implementing it against the one
sample at hand would promise more than it could keep, for the price of an XML
dependency.

**Booting the published attachment provider in the real-composition test.** It
normalizes through `sharp`, a native dependency this repo does not carry and
whose platform binaries are already the fragile part of this environment. The
composition test boots everything else for real and provides the one method the
plugin calls.

## Consequences

The fixture is a real Playwright report from a deliberately red run rather than
a written-by-hand sample, and that choice paid for itself twice: the runner
writes terminal colour codes into `error.message` but not into `error.snippet`,
and it attaches an `error-context` file to every failure unasked. Neither would
have appeared in a sample written from the type definitions.

Nothing in the channel can change a verdict. An unreadable report, a malformed
one, a file that vanished between the glob and the stat — each becomes a
diagnostic beside a report whose `passed` and `exitCode` still come from the
test command alone.

`maxEvidenceImages` defaults to 4 rather than being unbounded because the
harness evicts the *oldest* images from a request once its budget is exceeded:
an unbounded run would silently cost the conversation images established
earlier. Both caps report what they dropped and where the rest is, because a
silent cap reads as "this is everything the run produced".

Globbing uses `node:fs/promises` `glob`, which yields nothing rather than
throwing for every input this code can reach it with; the guard around it is
marked as the traversal-failure guard it is rather than padded with a test that
cannot exist.
