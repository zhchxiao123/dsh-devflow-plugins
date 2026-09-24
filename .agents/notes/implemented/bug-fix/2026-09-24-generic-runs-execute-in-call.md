# Agent Note: Generic runs answer inside the call

Status: implemented

## Problem

`jev_run` parked every generic checklist in a background job and returned a ticket. The callers are single-turn agents: the turn ends, the process exits, the job dies unwritten, and recovery marks the run interrupted — so every gate check landed at "interrupted 0/N" and waited for a human. The tool answered a question the agent needed now with "check back later", to a caller that has no later.

## Decision

A generic run executes to completion inside the calling operation and returns its answers; nothing is left running for a process exit to orphan. The per-check deadline bounds the wait; caller cancellation — the tool signal or an explicit cancel — persists an honest `cancelled` state, and resume re-executes only the unfinished checks, synchronously. Cancel bypasses the run lock on purpose: the lock is held by the execution being cancelled. Control is workspace-scoped rather than job-owner-scoped, so the panel resumes and cancels without a live agent — exactly the situation after a restart. Audits keep their background jobs: board-wide sweeps are the one shape that outlives a turn by design and their owner model still fits.

## Alternatives considered

- Keeping jobs and teaching agents to poll `jev_list`: the ticket model is the defect, not the polling discipline; a single-turn caller cannot poll.
- Detaching jobs from agent ownership: leaves the orphan-on-exit failure intact and violates the no-background-orchestrator rule more deeply.

## Consequences

Gate-check runs finish (or fail honestly) within the tool call that asked; the interrupted class disappears for generic runs. A worst-case checklist waits N × checkTimeoutMs inside one call — the deadline config is the lever. The jobs dependency leaves the runs plugin; `jev_control` resume returns the completed result instead of a job id.
