# Agent Note: a teardown that outran its budget

Status: implemented

## Problem

`packages/devflow-testenv/tests/engine.spec.ts` failed in CI on two independent
branches with the same message:

```
FAIL  runTestObserved over real processes
      > cancel leaves a reused environment up, because the earlier up() owns it
Error: Hook timed out in 30000ms.
 ❯ packages/devflow-testenv/tests/engine.spec.ts:36:1
```

It passed locally every time. Retrying the CI job turned it green. That profile
— intermittent, load-correlated, green on retry — invites treating it as noise
and re-running until it passes, at a rate around one run in two.

It is not noise, and the first diagnosis of it was wrong. That diagnosis is
recorded below rather than deleted, because the wrong model is the reason the
failure survived a round of "fixing".

### The first diagnosis, and its falsification

Three tests spawned `sleep 60` as a sentinel — a process that must outlive the
deadline being exercised — against a 30-second `afterEach` budget. The reading
was that teardown waits out the sentinel, so a 60-second child under a
30-second budget guarantees the timeout. The sentinel became `sleep 10`.

**CI then failed the same way on `5f2a346`, which carries that change.** The
sentinel was never the cause.

### The actual mechanism

`ctx.fiber.dispose()` reaches the harness's `disposeManagedProcesses`, which
awaits every handle's `done` and `waitForExit()` and imposes **no timeout of its
own**. A scope's `waitForExit()` is a poll:

```ts
let pollIntervalMs = 50                  // SCOPE_INITIAL_POLL_INTERVAL_MS
while (await this.rangeActive()) {       // each round forks a systemctl
  await this.waitForPoll(pollIntervalMs, generation)
  pollIntervalMs = Math.min(pollIntervalMs * 2, 5_000)   // SYSTEMCTL_TIMEOUT_MS
}
```

So the wait is not bounded by when a process dies. It is bounded by when a
poll whose interval doubles to five seconds next notices — and every round
contends for the scheduler on a loaded runner. This file boots a fresh Context
and subprocess runtime per case, twenty-seven of them, while other packages'
suites run beside it. One `afterEach` can serialize several of those waits.

The 30-second budget was the thing that was wrong.

## Decision

The budget is 120 seconds, behind a named constant whose doc derives it from
`SYSTEMCTL_TIMEOUT_MS` and the number of handles one case can leave behind, so
the next person who finds it short scales it against the same quantities rather
than picking a larger round number.

The sentinel stays `sleep 10`. It is a fine value on its own — the file runs
faster and the worst case is smaller — it simply never addressed this failure.
Its doc no longer claims a relationship to the teardown budget, because there
is none: teardown waits out a poll, not a sentinel.

The harness is not patched. Its polling design lives in `dsh-subprocess-local`,
and this line depends only on published surface, so the only lever available
here is giving the poll enough time.

## Alternatives considered

**Raise the budget** was rejected in the first round, on the grounds that "the
budget was not the thing that was wrong". That reasoning rested on the
falsified model. It is now the decision.

**Retry the job.** It works — every rerun passed. Rejected as the fix: the test
would keep blocking merges at whatever rate CI happens to be loaded, and a
release train is where that rate stops being tolerable.

**Share one runtime across the twenty-seven cases.** Fewer scopes to wait on,
and a real reduction rather than a larger budget. Not taken: it changes the
isolation between cases, which is a separate decision about what this file
proves, not a fix for a timeout.

**Assert the sentinel dies, and shorten it further.** Still the stronger change,
and still not taken. It needs the pid to reach the test through the engine's
spawn seam. See the gap below.

## What this does not claim

It does not establish that cancellation reaps the process tree promptly. The
engine says it does — a cancelled report carries "the command was cancelled and
its process tree was terminated" — but no test asserts the processes are gone.
If that path leaks, this file is now slower rather than failing, and the leak
stays invisible. Recorded so the next reader knows the coverage is absent
rather than assumed.

## Consequences

A genuine hang in teardown now takes two minutes to report instead of thirty
seconds. That is the whole cost, and it is the right trade against a gate that
randomly blocks merges and releases.

Worth reporting upstream, and not done here: `disposeManagedProcesses` having no
timeout means one escaped descendant can hang a fiber's disposal **forever** —
a hook timeout in tests, a stuck process in production. This note records the
observation; whether to raise it with the harness is the maintainer's call.
