# Agent Note: The pull request is part of the worktree ceremony, not one of two ways to merge

Status: implemented

English | [中文](2026-10-08-devflow-fixed-pull-request-flow.zh.md)

## Problem

The worktree runbook ended its ceremony with "Merge the branch (directly or through a pull request)", and that parenthesis was the whole of what this line said about submitting work. When a request was opened, what its body had to account for, who merged it, and what the card recorded about it were all undefined — so every project running devflow invented its own answer, and a reviewer reading a branch's diff had no reason to look at the card state travelling with it.

The same vague sentence had three copies — the runbook, the `docs/devflow.md` walkthrough, and `devflow-worktree`'s one-paragraph contract — which is three places for an answer to drift from.

Nothing on the card said where its work had been submitted, either. The journal recorded every stage move and every artifact, and then the branch left for GitHub without a trace.

## Decision

The runbook carries a fixed six-step flow, in the card's own worktree: confirm the card is committed, push the branch, open the request with `gh pr create` under a conventional-commit title and a body derived from the card, register that request on the card as a `pull-request` artifact, then merge once CI is green and the card still folds. The teardown section keeps what it always did and starts after the merge.

The body shape ships inside the runbook as a fenced block rather than as a second asset: the card and the stage it reached, one paragraph of why, three boxes accounting for the card state travelling with the merge, and a declaration of anything left red.

The `pull-request` artifact carries `card`, `kind`, `url`, `base`, and `head`, and it is attached **after** the request exists. That is the mirror image of the dispatch artifact, which must be attached before the branch exists, and the runbook states both orders against each other: a dispatch attached late writes the card on both sides of a fork, while a registration attached early has no URL to record. The registration lands as one more commit on the branch, which the request it names then carries.

The flow is ceremony, not a gate. CI already runs every check this repository has on every request, and `devflow-artifact-gate`'s cookbook now carries the one-line config a deployment adds when it wants the board to refuse a `done` that no request carried.

`devflow-worktree`'s skill catalog description advertises the flow and its trigger words, because the catalog line is the only thing that makes the runbook load. A flow nothing points at is not fixed, whatever the prose says.

### Why the artifact has no `merged` field

It records that a request was opened. Whether that request merged is a question `git log` answers directly, and claiming it on the card would cost a second attach and a second commit after the merge, from the main checkout, to restate a fact git already holds.

The consequence is that the opt-in gate buys less than its edge key suggests: configured on `testing->done`, it refuses a card no request ever carried, not a card whose request is still open. The cookbook snippet says so beside the snippet, because a deployment reading only the YAML would assume the stronger guarantee.

## Alternatives considered

**A gate of its own on the transition waterfall.** The only state such a gate could read is the `pull-request` artifact, and checking a required artifact kind on an edge is exactly what `devflow-artifact-gate` already does from config. A new package would have duplicated a configuration this line ships.

**An iron rule with a `check.sh`.** Iron rules keep their bodies resident in every request, which is the right price for an obligation and the wrong one for a flow deliberately left unenforced. The runbook's judgment loads on demand and costs nothing on turns that are not submitting work.

**A new stage, or a new `CardLocation`, for "submitted".** The stage set is closed on purpose. Adding a member touches the state machine, the edges of all three service classes, and every consumer that reads a stage — to represent a fact that lives in git and on GitHub rather than on the board.

**A devflow tool or command that opens the request.** This line has no GitHub write surface: `github-sync` is deliberately read-only, does not write to GitHub, and filters pull requests out of its intake. Opening one through devflow would mean standing up that surface for a step `gh` already performs in the agent's hands, and it would put a second actor in a flow whose executor is the harness agent.

**Shipping the body shape as its own asset file.** A consumer would have to locate it under `node_modules/@zhchxiao123/dsh-devflow-worktree/assets/`. Embedded in the runbook, it arrives inside a skill body that is already open at the moment it is needed.

## Consequences

Every project running the bundle gets one submission flow, advertised by the skill catalog and reachable from the words a user actually says. The card now records where its work was submitted, so the journal covers the branch's whole life rather than stopping at its last transition.

A deployment that wants the board to enforce the flow adds four lines of config. One that does not configure anything keeps the flow as ceremony, which is also what a deployment suppressing skills gets — guidance, never a guarantee, the same trade the rest of this line makes.

The catalog description is now 474 of its 500-character budget. The next thing worth advertising there will have to displace something.

`.github/PULL_REQUEST_TEMPLATE.md` in this repository is an instance of the shipped shape, not the shape itself, and the two can drift. The template's header comment names the runbook as the authority so a reader of either knows which one loses.
