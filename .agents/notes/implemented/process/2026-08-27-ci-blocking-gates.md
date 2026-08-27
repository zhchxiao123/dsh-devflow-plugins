# Agent Note: CI blocks on what it can decide, and runs where the code meets the platform

Status: implemented

English | [中文](2026-08-27-ci-blocking-gates.zh.md)

## Problem

Two holes in the gate, both of which let a change reach a tag unexamined.

**Preflight was advisory in CI.** It ran under `continue-on-error: true`, for a stated and correct reason: one of its checks asks whether this version is already on npm, and on a pull request the answer is "not yet" for every commit. But the flag applies to the run, not to the check, so *every* preflight check stopped blocking — including the one its own source calls out as "the one failure here that breaks a whole harness": a `dsh.client` declaration shipping without `lib/client.js`, which a harness treats not as a degraded install but as a refused boot. A packaging regression could only be caught by the release workflow, at the moment a mistake is most expensive to make.

The split is easy to see once stated: of preflight's checks, exactly one is about release timing. Manifest targets missing from the tarball, surviving `workspace:` ranges, a bundle patch the tarball does not carry, a client declaration without its bundle, drifted versions — all answer the same on a pull request as during a release.

**CI ran one platform.** `ubuntu-latest`, Node 22, no matrix. `devflow-filesystem` is the largest package in the line and is where it meets the operating system: `O_EXCL` creation for both the claim and the commit lock, `mtime` staleness, `rename`, `chmod` in the specs, and card directory names whose uniqueness assumes a case-sensitive filesystem. Windows makes `chmod` largely inert, APFS is case-insensitive by default, and `rename` across volumes fails. A line that claims to run wherever a harness runs was proven on one of the platforms a harness runs on.

## Decision

**`preflight --no-registry` is what CI runs, and it blocks.** The flag drops the registry lookup and keeps everything else, so the checks that can decide on a pull request do. The release workflow keeps running the full form, where the registry question is both answerable and worth asking.

The alternative — teaching preflight to recognize a release context and skip the check itself — was rejected: it would put an inference about the caller inside a script whose value is that it reports facts about tarballs.

**Two jobs rather than one matrix.** Typecheck, lint, and the tarball checks answer identically on every platform, so paying three times for them buys nothing; they stay on the cheapest runner. The test suite is what varies, so it runs on macOS and Windows as well, with `fail-fast: false` so one platform's failure does not hide another's.

**`concurrency` cancels superseded runs on branches, not on `main`.** A branch's newer push makes its older run irrelevant. A run on `main` is the record of what `main` was, so it is left to finish.

## Consequences

A packaging regression now fails a pull request rather than a release. The version-drift check moves with it, which matters because `set-version` is the only thing keeping eleven manifests in step.

**The new platforms are expected to surface existing failures**, and that is what they are for. The `chmod 0o444` spec that proves a park cannot be journaled is the obvious candidate on Windows, where the mode is largely inert. Such a failure belongs to the platform, not to this change: it should be recorded as its own issue and, if it blocks, that platform marked `continue-on-error` with the reason and the tracking link in the workflow — never by deleting the assertion.

CI on a pull request now costs three runners instead of one. `cancel-in-progress` on branches recovers part of that by not letting superseded runs finish.
