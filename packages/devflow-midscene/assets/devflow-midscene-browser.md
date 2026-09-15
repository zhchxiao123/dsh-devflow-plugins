# Browser checks with the official Midscene CLI

Use this skill to inspect or reproduce UI behavior in the configured workspace.
The deployment selects the target, visual model, credential reference and browser
connection. Harness owns the job; the official Midscene CLI performs UI actions.

## Check and run

1. Call `midscene_doctor`. A configured chat model is not automatically a configured
   visual model. Report missing configuration; never request keys in tool arguments
   or write credentials into the workspace. A static check does not prove a model
   request or authenticated page works.
2. Call `midscene_browser` with the selected profile. Omit `prompt` to observe the
   page; otherwise describe the desired action in natural language. Supply
   `assertion` for the expected visible result. Do not include passwords or tokens.
3. Wait for the returned job using existing job tools. Read its output and inspect
   its saved screenshots before deciding the next action. Do not issue concurrent
   operations against the same borrowed browser. A job starting is not success.
4. Summarize what was observed, attempted, asserted and failed. Link the saved
   screenshots and report. A screenshot-only run reports `observed`, not `passed`.

Each invocation opens the configured target, takes a screenshot, optionally runs
the official `act` and `assert` commands, takes another screenshot and releases its
connection. Commands are awaited individually. The owned browser is fresh per
job, with the configured login snapshot; combine a dependent page flow in one
natural-language action. A borrowed Chrome retains its state and remains open.
Its active tab can be navigated: select the intended test tab before connecting.
The Codex embedded browser is not automatically a CDP or Chrome Bridge target.

Use `job_kill` to cancel; wait for termination and check cleanup. Never interpret
`cleanup: unknown` as a stopped browser. A restart does not replay UI operations.
Exploration records live in the reported external directory; unfinished records
cannot prove success.

## Formal acceptance

Exploration is diagnostic evidence. To complete a Devflow card, use
`devflow-midscene-acceptance`: an approved suite, deployment identity and a fresh
completion-gate execution are separate requirements. Do not weaken a suite or
disable a policy to make a failed check pass.

## Official reference

The pinned upstream reference is `official-browser/SKILL.md`, with its license and
revision in `official-browser/PROVENANCE.md`. It documents CLI concepts and
screenshots, action, assertion and report handling. This Harness adaptation uses
the managed tools above instead of upstream installation commands, floating npx
versions, or project `.env` files. The bundled CLI is @midscene/web 1.12.6.
