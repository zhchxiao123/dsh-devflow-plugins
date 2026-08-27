# Agent Note: where devflow ends and Trellis begins

Status: proposed

English | [中文](2026-08-27-devflow-and-trellis-boundary.zh.md)

> **This one needs a person.** It is a decision about how the team works, not
> about how the code behaves, and it is written to be accepted, amended, or
> rejected rather than merged as-is.

## Problem

Two systems in the same workspace model the same thing.

| Trellis (`.trellis/`) | devflow (this line) |
|---|---|
| Phase 1 Plan — `prd.md` / `design.md` / `implement.md` | `draft` → `designing` → `ready` |
| Phase 2 Execute — implement / check | `developing` → `reviewing` → `testing` |
| Phase 3 Finish — spec update, commit | `done`, then `archiveDone` |
| Parent/child task trees, one level, independently verifiable children | Parent/child cards, one level, independently verifiable children |
| `.trellis/tasks/<name>/` plus jsonl manifests | `.devflow/tasks/<seq>-<slug>/` plus `journal.jsonl` |
| `task.py start` gates implementation on artifact review | Gate commands and approvals on the transition waterfall |

The overlap goes down to the rules: both restrict decomposition to one level, both require a child to be independently verifiable, both make the parent responsible for integration acceptance. That convergence is evidence the shape is right, not evidence of waste.

The waste is elsewhere. Maintaining both costs twice the attention, and neither accumulates the other's experience — a lesson learned about how parents and children behave in Trellis teaches devflow nothing, and vice versa. Worse, the boundary today is held by habit rather than by a rule, so which system a piece of work lands in depends on who starts it.

**This repository is the sharpest case.** devflow is a development-process system whose own development is tracked in Trellis and in `.scratch/` markdown, with not one devflow card. Defects that only appear in use — the driver stalling after one stage, a gate killed by a default timeout, `attachArtifact` deadlocking from inside a gate — had no chance to surface, and all three were found by reading code instead.

## Proposal

**Option 2: an explicit division, written down.** Trellis owns the inside of one agent session; devflow owns work that outlives a session or crosses people.

- **Trellis** is a session's scratchpad and checklist. It plans what this session will do, holds the artifacts that planning produces, and closes when the session's work is committed. Its unit is a task somebody is doing now.
- **devflow** is the requirement's public record. It answers "where is this" for anyone who was not in the session, survives restarts and hand-offs, and carries the gates a deployment enforces. Its unit is a card that outlives whoever is holding it.

A piece of work large enough to span sessions gets a devflow card first; each session against it may open a Trellis task and close it, and the card stays.

The two other options and why they are not the recommendation:

- **Option 1 — devflow absorbs Trellis's artifact model** (`designing` cannot reach `ready` until three artifacts are attached; devflow's gates can enforce exactly that). Nearly free to build, and tempting. It is a bigger bet than it looks: it makes devflow the only system, so every session — including a five-minute question — pays card overhead. Worth revisiting after Option 2 has run for a while and the boundary has been observed rather than predicted.
- **Option 3 — retire one.** Retiring devflow discards a published, tested plugin line. Retiring Trellis discards the workflow this repository is currently developed with. Neither is justified by "they overlap".

**The status quo — both, with the boundary held by habit — is the worst of the three options**, because it costs the maintenance of two systems and delivers the clarity of neither.

## What follows if this is accepted

1. Write the division into both `AGENTS.md` and `.trellis/workflow.md`, so the rule lives where each system's users read.
2. Adopt devflow for this repository's own next requirement — cards for the work, no driver at first (it spends model budget the moment a card moves), just `devflow_create`, `/devflow`, and the board. Record what breaks. That is the dogfooding gap this note's Problem section describes, and it is the only part of this proposal that produces evidence rather than agreement.
3. Leave the 22 existing `.scratch/devflow/` issues where they are. Migrating history buys nothing; the rule applies to new work.

If it is rejected, the alternative that needs the least new thinking is Option 1, and the thing that must not happen is another quarter of the status quo.
