# Agent Note: Triage Skips Only What It Scored Low AND Was Sure About

Status: implemented

## Problem

A code review over a large change is mostly reading that did not need to
happen. A formatting sweep and an authorization change arrive in the same diff,
and whoever reads them spends the same attention on both. The obvious fix — ask
a model which files matter — has a failure mode that makes it worse than doing
nothing: a model that is wrong about one file quietly removes that file from
review, and nobody finds out until the thing it was hiding ships.

So the question was never "can a model rank files". It was "what shape makes
being wrong harmless".

## Decision

`jev_triage` scores each changed file against a rubric and returns `skip` or
`review` per file. A file is `skip` **only when it scored below `skipBelow` AND
its confidence was at or above `confidenceFloor`**. Every other outcome is a
review, and the list is deliberately long: a high score, low confidence, a
failed judgement, a binary file, a file past the batch size, a diff too large
for the call, a missing answer, an answer of the wrong kind, a path that is not
absolute, a `git diff` that could not be read.

That conjunction is the whole design. Skipping something risky requires both a
low score and high confidence about it, so every way the judgement can degrade
lands on the safe side by construction rather than by a check somebody
remembered to write. The worst case this tool has is a review nobody needed.

Two consequences follow from it and are worth stating because they look like
oversights otherwise:

**A truncated `git diff` capture is a fault, not a smaller diff.** Half a file's
diff parses perfectly well and would be scored as though it were the whole
change — a confident wrong answer with nothing marking it as one. The tool
reports unavailable instead.

**A truncated single-file diff is fine and still judged.** Cutting a file's diff
short can only make the judgement more conservative, so the file stays in the
batch with its diff shortened rather than being pushed to review.

Confidence is checked before the score, so a low-confidence answer reports that
rather than the number it did not trust — the difference matters when someone
is tuning the floor.

Cancellation is the one failure that is not folded into the rule: `JEV_ABORTED`
is re-raised. A withdrawn call returning a full set of conservative verdicts
would look exactly like a call that had succeeded.

Each file is its own question carrying its own diff. Every question in one call
is answered against the same shared state, so a state holding every file's diff
would let the files anchor each other; the state carries only what is true of
every question.

## Alternatives considered

**Wiring this into `devflow-review-gate` directly.** That gate already resolves
the authoritative file list and already models "reviewed or skipped, with a
reason", so triage would have dropped straight in. Rejected for v1 because it
would give a fail-closed gate a network dependency and an API key of its own —
its README currently promises neither — and that is a product decision rather
than a technical one. The gate can `inject: ['jev']` whenever that trade is
made; nothing here has to change for it.

**A second call for the files that did not fit.** Rejected: a second request is
a second chance to partially fail, and what it buys is a few files not being
read.

**Registering the tool only when a judgement is available.** Rejected. The tool
list is part of a request's header, so a table that appears and disappears with
credential state both breaks prefix caching and leaves "where did that tool go"
as the diagnosis. The tool registers unconditionally and says so when called.

## Consequences

Triage is only ever worth what the rubric is worth, and the rubric is
configuration: a deployment that disagrees with the five default levels edits
them, and the score ceiling follows the list's length rather than a constant.
Setting `skipBelow: 0` leaves the tool mounted while trusting none of it, which
is the honest first setting for a team that wants to read the scores for a while
before acting on them.

The cost of the conjunction is that the tool is conservative by default and will
often skip nothing at all — on a diff the model finds unfamiliar, every file
comes back as a review and the call bought nothing but its own latency. That is
the intended failure, not a tuning problem.

## Testing

`tests/triage.spec.ts` covers the rule at both boundaries — a score exactly at
the line and a confidence exactly at the floor — and every degradation path.
`tests/diff.spec.ts` covers quoting against spaces, quotes, `$`, backticks,
newlines, and semicolons, and treats a truncated capture as a fault.
`tests/loader-composition.spec.ts` boots the real Loader over a real git
repository whose directory name carries a space and an apostrophe, with the
judgement as the only double: the two failures unit tests cannot see are a
command git will not accept and real git output that does not split the way the
parser expects.

No file in `packages/jev-triage/` names a provider package. That is what makes
"this consumer does not know who answers" a checked property.
