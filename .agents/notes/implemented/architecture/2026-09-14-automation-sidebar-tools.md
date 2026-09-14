# Agent Note: Native automation sidebar and tool consumers

Status: implemented

English | [中文](2026-09-14-automation-sidebar-tools.zh.md)

## Problem

Slash commands expose scheduling and GitHub intake but require users to remember syntax and read raw records. Users need natural-language control and a persistent place to inspect accepted work without confusing it with completed synchronization.

## Decision

Add independent scheduler and GitHub tool consumers, a host-scoped HTTP management face, and an Automation page in the Harness native right Sidebar. The page uses the same tab-type registry and keyed slot as Devflow UI. It does not depend on the currently viewed session or replace the existing board.

All entrances call the existing public services. Plans, subscriptions, runs, cancellation tombstones, capacity limits and consumer acknowledgements remain owned by those services. Tool actor identity comes from the real call context; the Web face records its human entrance after enforcing the existing local-host request trust boundary. Wire schemas validate requests and responses; external content is rendered as text.

The page separates subscriptions, schedules and run history, preserving delivery versus downstream status. Visible pages refresh persisted state and retain previous data when refresh fails. Creating or changing a GitHub schedule uses a form; generic handler parameter editors and dynamic form generation remain outside this iteration.

## Alternatives considered

**Wrap slash commands.** This duplicates parsing and loses typed arguments, caller attribution and native tool result presentation.

**Embed in the Devflow board.** Scheduling is host scoped and can serve consumers unrelated to a Devflow workspace. An independent native page keeps the established board intact.

**Create another management state machine.** Repeating recovery, cancellation and admission rules in HTTP or React would allow the same action to behave differently depending on its entrance.

## Consequences

Users can act directly in the panel or through model tools and observe the same durable outcome. Browser and tool availability can fail independently of background providers. Client bundles must use the published Harness module table and are built with the shared loader-factory preset. Real Loader, tool, HTTP and component checks supplement packed-profile and browser acceptance, which are recorded separately.

## Verification

Node 24.18.0 and pnpm 11.24.0: 132 test files / 1,653 tests pass; package and tools TypeScript checks pass; lint has no errors (three existing unused-disable warnings). Repository-wide coverage passes at 100% statements, branches, functions and lines per file (6,418 statements, 4,253 branches, 1,549 functions, 5,552 lines). The clean build and 29-package tarball preflight pass.

Real Loader composition verifies tools and HTTP share subscription, plan and run state, including failed synchronization resumed through the other entrance. Browser regression tests cover slow single-flight reads and independent error retention. Response-decoder regressions preserve long names and exact handler identity.

An isolated packed Web profile exercised the native Sidebar at 756px and 1440px: subscription creation, immediate synchronization, plain-text issue content, interval plan creation, manual dispatch, pause/resume and completed run history. GitHub was a loopback fixture; the Harness host, plugin Loader, SQLite providers, HTTP and browser client were real. The 17 tools were discovered through the real tool runtime and a query was executed. No LLM request or live GitHub account synchronization was performed.

The four consumer tarballs were installed through the Harness CLI into the local Web profile after backing up its configuration. The native Automation entry and empty subscription panel loaded without browser warnings or errors; the live HTTP overview reported both providers available. No test subscriptions or plans were written to that profile. Host runtime reported 0.1.5-rc.2-fb2c4b9; package dependencies and composition tests use published 0.1.5-rc.2 surfaces.
