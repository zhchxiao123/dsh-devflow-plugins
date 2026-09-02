# testenv Bootstrap

Turn how this project's integration-test environment starts into a `testenv.yml` manifest at the workspace root, so the `env_up` / `env_status` / `env_logs` / `env_down` / `integration_test` tools can run it deterministically from then on. The tools execute the manifest exactly as written; every judgment — which services exist, how they start, what "ready" means — is made here and recorded in the manifest, which is reviewed and committed like any other project file.

## 1. Research how the environment starts

Read these sources in order and stop as soon as the start commands and readiness conditions are established:

1. **CI configuration** (`.github/workflows/`, `.gitlab-ci.yml`, and similar): the most reliable source. An integration-test job already names the services it brings up, their start commands, its health waits, and the test command — and CI passing proves those work.
2. **Compose files, Makefiles, package scripts** (`docker-compose*.yml`, `Makefile`, `package.json` scripts, `scripts/`): start and stop commands, ports, and dependency order.
3. **README and contributor docs**: prose instructions; verify any claim not already confirmed by 1–2 before writing it into the manifest.
4. **Controlled experiments**, only for what remains unknown: run the candidate start command yourself, observe which port or endpoint answers, then tear it down.

The manifest is this skill's only persistent artifact. Temporary files a controlled experiment creates go under `/tmp` or are deleted when the experiment ends; none stay in the repository.

## 2. Write the manifest

Start with the single most upstream service plus the test command, prove that loop (section 3), then add the next service. All fields:

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

Rules the validator enforces (every violation is reported at once, with its field path):

- `services` needs at least one entry; names must be unique; unknown keys are rejected.
- Every service needs `up` and exactly one `ready` probe. A `command` probe (`command: { run: "pg_isready" }`) counts exit 0 as ready and any other exit as not ready yet.
- `http` probes accept only absolute `http://` URLs, never `https://`.
- `kind: static` is reserved and not implemented; run every service as a process.

One start rule covers self-exiting commands (`docker compose up -d`) and long-running ones (`pnpm start`) alike: a passing probe means ready whether or not the process still runs; a process that fails before its probe passes fails the service; and one service failing tears every already-started service back down in reverse order.

A command too complex to inline in the manifest goes into the project's existing script directory and is referenced by its path relative to the workspace root; do not create a new directory for testenv.

## 3. Prove the loop

A manifest counts as written only after, in one session:

1. `env_up` reports every service `ready`;
2. `env_status` re-probes and reports every service healthy;
3. `env_down` reports no residue.

Then run `integration_test` and confirm the report reaches the `test` phase. If any step fails, treat it as section 4 with that failure in hand. Do not leave a manifest in the repository that has not passed this loop.

## 4. Repair a rotten manifest

When the tools report a failure against an existing manifest:

1. The error names the failing service, the phase, and the exit facts; the failure's log tail, or `env_logs` on that service, shows its output.
2. Re-verify that service's start command and probe against the project's current source of truth, in section 1's order — CI configuration first.
3. Update only what changed in `testenv.yml`.
4. Re-run the section 3 loop before considering the repair done.
