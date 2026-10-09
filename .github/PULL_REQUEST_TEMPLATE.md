<!--
Convention, not a gate. CI is the gate; nothing here blocks a merge.
Not a devflow card (harness bump, release chore, docs fix)? Keep "What changed",
delete the rest.

The four sections below are this repository's instance of the body shape that
packages/devflow-worktree/assets/devflow-worktree-runbook.md ships to every
project running devflow. That runbook is the authority; keep the two in step.
-->

## Card

- Card: `<card-id>`
- Stage this branch drove it to:
- Developed in: its dispatched worktree / the main checkout

## What changed

<!-- One paragraph: the why. A reviewer can read the diff. -->

## What travels with the merge

<!--
Card state is part of the deliverable, and it is the half of the diff a code
review reads past. The three boxes are the three ways a worktree's merge goes
wrong silently.
-->

- [ ] The card's `journal.jsonl` revisions stay contiguous after the merge — no
      second checkout appended to this card
- [ ] `artifacts/` carries every report this branch produced (midscene, review
      gate); the inspect history under `$DSH_HOME` does not survive the
      worktree's removal
- [ ] No process-transient state committed: `claim.json`, `commit.lock`,
      `midscene/operation.lock`

## Known-failing

<!-- Anything left red on purpose, and why. Empty means everything is green. -->

## After merge

- [ ] Worktree and branch removed (`git worktree remove …`, `git branch -d …`)
- [ ] Card's post-merge board action taken from the main checkout — `done`,
      archive, or a follow-up card
