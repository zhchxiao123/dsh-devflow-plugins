# testenv Bootstrap

Turn how this project's integration-test environment starts into a `testenv.yml` manifest at the workspace root, so the `env_up` / `env_status` / `env_logs` / `env_down` / `integration_test` tools can run it deterministically from then on. The tools execute the manifest exactly as written; every judgment — which test suite the environment serves, which services exist, how they start, what "ready" means — is made here and recorded in the manifest, which is reviewed and committed like any other project file.

**Fast path.** A project with exactly one test configuration, one CI test job, and no workspace or monorepo structure has nothing to select between: that suite is `test`, its CI job names the services and their commands, and sections 1–3 may be skipped — read section 1's sources for the start commands, then continue at section 4. Any of these signals ends the fast path and requires the full survey: more than one test configuration (several `vitest.*.config` files, a `pytest.ini` beside a JavaScript suite, distinct Makefile test targets), more than one CI job that runs tests, or a workspace/monorepo layout.

## 1. Survey the test landscape

Enumerate every test entry point in the repository before judging any of them: CI jobs that run tests, test scripts in every `package.json` of the workspace, every test-runner configuration (`vitest.*.config` files, `jest.config.*`, `pytest.ini`, `tox.ini`, `pyproject.toml` test sections), and Makefile or script-directory test targets. Classify each entry as unit, integration, or end-to-end. The survey is complete when every entry point is classified, not when the first runnable suite is found — the first suite that runs is usually the most heavily mocked one.

Read sources in this order of reliability:

1. **CI configuration** (`.github/workflows/`, `.gitlab-ci.yml`, and similar): the most reliable source. An integration-test job already names the services it brings up, their start commands, its health waits, and the test command — and CI passing proves those work.
2. **Compose files, Makefiles, package scripts** (`docker-compose*.yml`, `Makefile`, `package.json` scripts, `scripts/`): start and stop commands, ports, and dependency order.
3. **README and contributor docs**: prose instructions; verify any claim not already confirmed by 1–2 before writing it into the manifest.
4. **Controlled experiments**, only for what remains unknown: run the candidate start command yourself, observe which port or endpoint answers, then tear it down.

The manifest is this skill's only persistent artifact. Temporary files a controlled experiment creates go under `/tmp` or are deleted when the experiment ends; none stay in the repository.

## 2. Trace each suite's service binding

For every candidate integration or end-to-end suite, establish how its tests reach their services: an environment variable, a configuration file, a hardcoded port, or not at all because every dependency is mocked in-process. A fully mocked suite must not be chosen as `test` — the environment has no causal effect on its verdict, and negative verification (section 6) proves that by staying green.

## 3. Choose the test suite and record the eliminations

Choose as `test` the suite whose verdict depends on the running services. Record every eliminated candidate in the manifest's header comment with a one-line reason — fully mocked, unit-only, needs credentials the environment cannot provide, subsumed by the chosen suite — because an unexplained absence reads as an unexamined one and triggers a re-survey on every repair.

## 4. Inventory the preconditions

List what must already hold before `env_up` can succeed: installs, builds, migrations, container images, generated fixtures. Verify each on this machine — run it or observe its artifact — and record the inventory in the manifest's header comment; a precondition that lives only in session memory resurfaces in the next session as an unexplained service failure.

## 5. Write the manifest, comments complete

All fields:

```yaml
services:                 # ordered list; starts top to bottom, tears down in reverse
  - name: db              # unique name; env_logs and failure reports address services by it
    up: docker compose up -d postgres   # shell command that starts the service
    ready:                # exactly one probe: tcp, http, or command
      tcp: { port: 5432 }               # host optional, default 127.0.0.1
    down: docker compose down           # optional; omitted → the up process tree is terminated
    env: { PGPORT: "5432" }             # optional; layered over a scrubbed parent environment
    cwd: services/db                    # optional; relative to the workspace root
    readyTimeoutMs: 60000               # optional per-service readiness deadline
  - name: api
    up: pnpm run start:test
    ready:
      http: { url: "http://127.0.0.1:3000/healthz" }  # status optional, default any 2xx
seed: pnpm run db:seed    # optional; integration_test runs it between up and test
test: pnpm run test:integration         # required
```

The header comment carries the manifest's scope and provenance, so a reader or a later repair starts from the manifest instead of re-running the survey:

- a **scope declaration**: which suite the environment serves, what it deliberately does not cover (the section 3 eliminations with their reasons), and the section 4 preconditions;
- **per-entry provenance**: for each service and for `test`, the source file the command was taken from (path; line number optional).

Compact form (generic example, not a template to copy verbatim):

```yaml
# Integration env for the api package: postgres + api server, exercised by the
# HTTP contract suite. Not covered: the unit suites (all dependencies mocked)
# and the browser e2e suite (needs external SaaS credentials).
# Preconditions: pnpm install has run; docker image postgres:16 is pulled.
services:
  - name: db
    # Source: .github/workflows/ci.yml, job "integration".
    up: docker compose up -d postgres
    ready:
      tcp: { port: 5432 }
# Source: packages/api/package.json, script "test:integration".
test: pnpm -C packages/api run test:integration
```

Rules the validator enforces (every violation is reported at once, with its field path):

- `services` needs at least one entry; names must be unique; unknown keys are rejected.
- Every service needs `up` and exactly one `ready` probe. A `command` probe (`command: { run: "pg_isready" }`) counts exit 0 as ready and any other exit as not ready yet.
- `http` probes accept only absolute `http://` URLs, never `https://`.
- `kind: static` is reserved and not implemented; run every service as a process.

One start rule covers self-exiting commands (`docker compose up -d`) and long-running ones (`pnpm start`) alike: a passing probe means ready whether or not the process still runs; a process that fails before its probe passes fails the service; and one service failing tears every already-started service back down in reverse order.

A command too complex to inline in the manifest goes into the project's existing script directory and is referenced by its path relative to the workspace root; do not create a new directory for testenv.

`testenv.yml` is written only at the session's workspace root — never into the harness checkout or any other directory. The tools resolve the manifest against the calling session's working directory; if a tool reports looking for the manifest anywhere else, that is a deployment or plugin defect to report, not something to bridge by writing a shim manifest where the tool looked.

## 6. Prove the loop, then falsify it

A manifest counts as written only after, in one session:

1. `env_up` reports every service `ready`;
2. `env_status` re-probes and reports every service healthy;
3. `env_down` reports no residue.

Then run `integration_test` and confirm the report reaches the `test` phase. If any of these steps fails, treat it as section 8 with that failure in hand.

Then falsify the service binding — a green run alone does not prove the tests use the environment:

1. `env_down`. The tools stop the environment whole, never one service, so the whole environment is the unit of falsification. `integration_test` cannot drive this step — it raises a down environment itself — so the red run uses the shell directly.
2. Run the manifest's `test` command exactly as written, from the workspace root, in the shell. The run must turn red. A run that stays green against a down environment does not depend on it: the section 2 binding analysis was wrong — return there and choose again.
3. Restore: `env_up`, then one more green `integration_test` (it reuses the running environment), then `env_down`.

Do not leave a manifest in the repository that has not passed both halves of this loop.

## 7. Report the survey

End the bootstrap by reporting to the user in the session — not in a file: the test entry points found and their classification, the chosen `test` suite, the eliminated candidates with their reasons, and the negative-verification outcome. The manifest's header comment carries the durable subset; the in-session summary is where a wrong selection gets vetoed before it settles into review.

## 8. Repair a rotten manifest

When the tools report a failure against an existing manifest:

1. The error names the failing service, the phase, and the exit facts; the failure's log tail, or `env_logs` on that service, shows its output.
2. Re-verify that service's start command and probe against the project's current source of truth, in section 1's order — CI configuration first.
3. Update only what changed in `testenv.yml`, provenance comments included.
4. Re-run the section 6 loop — falsification included — before considering the repair done.
