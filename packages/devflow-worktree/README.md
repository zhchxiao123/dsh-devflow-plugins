# @zhchxiao123/dsh-devflow-worktree

English | [中文](README.zh.md)

Worktree-per-card development: one card, one branch, one linked git worktree.
The package ships two contributions — the bundled `devflow-worktree-runbook`
skill carrying the ceremony, and a fence on the `devflow/transition`
waterfall holding a dispatched card to the worktree its dispatch names.

## Why a worktree is already a workspace

Devflow resolves every root from the calling session's own directory
(`<cwd>/.devflow`), and `.devflow/` is committed to the repository. A linked
worktree therefore checks out a complete board: the branch carries the card,
the card's workspace is the worktree, and gate commands, review-gate
reviews, and agent-gate checkers all run there — those packages already anchor to the
parent of the card's devflow root. Nothing here changes how any consumer
resolves a directory; the package adds the process (a skill) and the one
guarantee the process cannot carry by itself (the fence).

## The ceremony

The runbook's contract, in one paragraph: bring the card to `ready` on the
main board; attach a dispatch artifact — the configured kind, default
`worktree`, with frontmatter `branch`, `base`, and `worktree` — then commit
it and `git worktree add <path> -b <branch>`, in that order. Develop in a
session whose working directory is the worktree: `devflow_take` there, commit
code and card state to the branch, drive the card through its edges. Merge
the branch to deliver code and journal together, then remove the worktree
and branch. From dispatch to merge, only the card's own worktree writes the
card — two checkouts appending one journal merge into a revision conflict
that renders the card unreadable, by design and loudly.

## The fence

On each transition the fence reads the moving card (via the optional
`devflow` service, by name), and looks for the newest artifact of the
configured kind. No such artifact: the card is untouched and the fence
delegates. Otherwise the transition's workspace — the parent of the
attempt's root — must canonicalize to the dispatch's `worktree`, or to the
repository's main working tree, derived per directory from
`git rev-parse --path-format=absolute --git-common-dir` and cached. The
main-tree admission is what lets the main checkout archive or follow up a
merged card after its worktree is deleted. Every other checkout is vetoed
with both directories named; an unreadable or malformed dispatch record also
vetoes, because a fence that guessed would wave through exactly the writes
the record exists to stop.

## Configuration

```yaml
- name: '@zhchxiao123/dsh-devflow-worktree'
  # config:
  #   artifactKind: worktree   # must match the kind the artifact-gate declares
```

Declare the kind's structure in the deployment's artifact-gate so a dispatch
cannot be registered half-filled:

```yaml
kinds:
  worktree:
    frontmatter: [branch, base, worktree]
```

## Known limitations

- **The fence guards transitions only.** Artifact registration and card
  creation are not fenced: attaching from the wrong checkout is still a
  both-sides write the runbook prohibits but the fence cannot see. The
  attach plane is also the escape hatch — a moved worktree re-dispatches
  itself by attaching an artifact naming its current path — so fencing it
  would close the recovery path along with the mistake.
- **A dispatch in a non-git checkout always vetoes.** A copy of the board
  outside any git work tree has no main working tree to admit, which is the
  fail-closed reading of a checkout the ceremony never produces.
- **Worktree sessions do not see harness workspace registrations.** The
  automation, scheduler, and github-sync planes resolve the session's
  directory against the harness workspace registry, and a worktree is not
  registered there; those tools reject in a worktree session. They are
  background intake, not the development loop, and the main checkout's
  session keeps serving them.
