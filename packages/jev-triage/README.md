# Diff triage tool

Registers `jev_triage`: score each changed file in a git working tree for review risk, so the expensive reading in a code review goes to the parts that need it. It consumes `ctx.jev` and knows nothing about which provider answers — compose it with `@zhchxiao123/dsh-jev-typesafe`, or with anything else that provides the seam.

```yaml
- jev-triage:
    skipBelow: 2
    confidenceFloor: 0.4
```

```
jev_triage { "cwd": "/path/to/repo" }
jev_triage { "cwd": "/path/to/repo", "base": "main" }
```

Each changed file becomes its own question carrying its own diff, and all of them are answered in one call. A file's diff rides in that file's question rather than in the shared state, because every question in a call is answered against the same state — a state holding every diff would let the files anchor each other.

## The rule

**A file is skipped only when it scored below `skipBelow` AND the judgement's confidence was at or above `confidenceFloor`.** Everything else is a review: a high score, low confidence, a failed judgement, a binary file, a file past the batch size, a diff too large for the call, a missing answer, an answer of the wrong kind. Triage skipping something risky is therefore not a thing that can happen — the worst case is a review nobody needed.

Confidence is checked before the score, so a low-confidence answer reports that rather than the score it did not trust.

A withdrawn request is re-raised rather than folded into that rule. A cancelled call that came back with a full set of conservative verdicts would look like it had succeeded.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `scoreLevels` | a five-level rubric, Trivial → Critical | The rubric. Its length is the score ceiling, so adding or removing a level moves the ceiling with it. At least two — one level has nothing to discriminate. Each level reads `Name: what it covers`, and the name before the colon is what the result shows. |
| `scoreInstruction` | asks how likely the change is to hide a defect worth expert review | How risk is described to the model. |
| `skipBelow` | `2` | Below this score a file may be skipped. `0` never skips anything, which is how to leave the tool mounted while trusting none of it. |
| `confidenceFloor` | `0.4` | Below this confidence nothing is skipped, whatever it scored. |
| `maxFiles` | `40` | Files per call; the rest are reviewed without being scored. |
| `maxFileChars` | `6000` | Characters of one file's diff that reach the model; past it the diff is truncated and **still judged**, because a truncated diff can only make the judgement more conservative. |
| `maxTotalChars` | `28000` | Characters across one call; a question past it is not asked and its file is reviewed. |
| `stdoutMaxBytes` | `4194304` | Bytes of `git diff` collected. **A truncated capture is a fault, not a smaller diff** — half a file's diff still parses, and would be scored as though it were the whole change. |
| `timeoutMs` | `60000` | Deadline for the whole call. Enforced only where `@deepseek-ai/dsh-tool-call-timeout-policy` is composed. |

Misconfiguration fails at load, naming the field.

## What it reads

`git -C <repo> diff --no-color --src-prefix=a/ --dst-prefix=b/ --no-ext-diff <ref>`. The prefixes are forced so the split works whatever `diff.mnemonicPrefix` is set to locally, and `--no-ext-diff` stops an external driver from replacing the output shape. `ctx.shell` takes a command **string**, so both the repository path and the ref — each of which arrives from the model — are single-quoted before they reach it.

## Known limitations

**Untracked files are not covered.** `git diff` does not list them. The result says so; list them with `git status`.

**No batching.** Files past `maxFiles`, and questions past `maxTotalChars`, are reviewed rather than asked about in a second call. A second request is a second chance to partially fail, and what it would buy is a few files not being read.

**No cross-session record.** The tool's own result is the durable, replayable account of what was judged — it lands on the session's `tool/result` and survives a reload. Comparing a skip against what a review later found has to be done from session history rather than from a purpose-built log.

**`timeoutMs` needs a policy plugin.** The field is declared, but `@deepseek-ai/dsh-tool-call-timeout-policy` is what enforces it; without that row composed, the deadline is advisory.
