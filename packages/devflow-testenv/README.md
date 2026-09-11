# @zhchxiao123/dsh-devflow-testenv

English | [中文](README.zh.md)

Declarative test environments: a `testenv.yml` manifest at the workspace root names the services, their readiness probes, and the test command; five deterministic tools — **`env_up`**, **`env_status`**, **`env_logs`**, **`env_down`**, **`env_test`** — execute it over [`ctx.subprocess`](https://www.npmjs.com/package/@deepseek-ai/dsh-subprocess); and a bundled **`testenv-bootstrap`** skill owns writing and repairing the manifest. The harness's `bash(run_in_background)` already covers one background command with tail and kill — this plugin exists for what that cannot express: an ordered multi-service topology with readiness gates, one whole-environment teardown, and zero per-session re-research; `env_test` takes the same `run_in_background` parameter, so the orchestrated run itself registers as one harness job instead of losing long suites to a raw shell. Environment knowledge is written once into the repository and reviewed like any other file; interpretation of failures stays with the model, so the plugin is an executor, never a second orchestrator.

## The manifest

`services` is an ordered list — declaration order is the start order and the reverse of the teardown order. Each service starts only after the previous one's probe passed. The whole file is validated in one pass; every defect is reported at once with its field path.

```yaml
services:                 # ordered list; at least one service; names unique
  - name: db
    up: docker compose up -d postgres   # required; shell command that starts the service
    ready:                # required; exactly one probe: tcp, http, or command
      tcp: { port: 5432 }               # host optional, default 127.0.0.1
    down: docker compose down           # optional; omitted → the up process tree is terminated
    env: { PGPORT: "5432" }             # optional; layered over a scrubbed parent environment
    cwd: services/db                    # optional; relative to the workspace root
    readyTimeoutMs: 60000               # optional; default Config.defaultReadyTimeoutMs
  - name: api
    up: pnpm run start:test
    ready:
      http: { url: "http://127.0.0.1:3000/healthz" }  # status optional, default any 2xx
seed: pnpm run db:seed    # optional; env_test runs it between up and test
test: pnpm run test:integration         # required
evidence: test-results/**               # optional; globs naming what a red run leaves on disk
report:                                 # optional; a machine-readable report of that run
  path: test-results/report.json
  format: playwright-json
```

| Field | Meaning |
|---|---|
| `services[].name` | Unique name; `env_logs` and failure reports address services by it. |
| `services[].up` | Shell start command. One rule covers self-exiting (`compose up -d`) and long-lived (`pnpm start`) commands alike: a passing probe means ready whether or not the process still runs; a process that fails before its probe passes fails the service; a clean exit keeps the probe polling until the readiness deadline. |
| `services[].ready` | Exactly one of `tcp` (a connection opens), `http` (a GET answers the wanted status; absolute `http://` URLs only, requested direct — never through a proxy), or `command` (exit 0 is ready, any other exit is "not yet"). |
| `services[].down` | Optional stop command, run first at teardown under `Config.downTimeoutMs`; the up process tree is terminated afterwards either way. |
| `services[].kind` | `'process'` (the default). `'static'` is **reserved** for future static preview hosting: validation rejects it with a dedicated "reserved, not implemented" error, distinct from the unknown-value error a typo gets. |
| `seed` / `test` | Top-level commands `env_test` runs in the workspace root. |
| `evidence` | One glob or a list of them, relative to the workspace root, naming what a **red** run writes — screenshots, traces, videos, logs. Declaring them is what makes them checkable: after a failed run the tools expand the globs and report what matched, **including that nothing did**, so a renamed output directory surfaces instead of quietly yielding a failure report with no evidence in it. |
| `report` | `path` plus `format` of a machine-readable report of the test command's own run. `playwright-json` is the one implemented format; see the limitations below for why JUnit XML is not. |

Both evidence fields are optional and apply only to a red test phase: a green run has nothing to explain, and a manifest declaring neither reports exactly what it reported before. Paths are contained at load time — an absolute path, or one normalizing outside the workspace root, is a manifest defect rather than a read-time surprise, because a pattern reaching past the root would read files the workspace never offered.

Any service failing to start rolls every already-started service back in reverse order before `env_up` returns; the failed service's report carries the phase, the exit facts, and its log tail. A running environment is registered as an effect of the plugin's fiber whose disposer is the whole teardown, so the session ending tears the environment down — orphaned service processes are ruled out structurally, not by cleanup code. The workspace root resolves per call from the calling agent session's working directory (the same per-call source `dsh-devflow-tool` derives its root from), so one long-lived harness serves many project workspaces, each with its own engine and environment; the manifest path and every service `cwd` resolve against the caller's root, and a call without a session working directory fails loud instead of falling back to the harness process cwd — which in a long-lived deployment points at the harness checkout, not any workspace. Sessions whose working directories name the same workspace share that workspace's one engine and its single environment: an `env_down` from any of them tears the shared environment down.

## The tools

| tool | arguments | wire value |
|---|---|---|
| `env_up` | — | `{ ok, services: [{ name, state: ready\|failed\|not-started, probe?, readyAfterMs?, detail?, logTail? }], durationMs?, teardownDetail? }`; `durationMs` is milliseconds the whole up attempt took (including any rollback), `readyAfterMs` milliseconds from the service's spawn to its readiness probe passing, and `teardownDetail` reports the rollback's own residue when tearing the started services back down itself failed. |
| `env_status` | — | Same shape, re-probed: every readiness probe runs again, so the answer is current health, not whether `env_up` once succeeded; each entry carries its `probe` kind and `probeMs`, the milliseconds the re-run probe took to answer. No services while the environment is not up. |
| `env_logs` | `service`, `fromOffset?` | `{ text, nextOffset, lossy }` — stdout with stderr merged, as a bounded in-memory tail; pass `nextOffset` back to read only what is new. Readable after a service's process exits, until teardown. |
| `env_down` | — | `{ ok, detail? }` — reverse start order, `down` command first, process-tree termination always; failures are aggregated into `detail`, never stopping later services' teardown. Idempotent when already down. |
| `env_test` | `run_in_background?` | `{ passed, phase: up\|seed\|test, exitCode?, outputTail?, detail?, services?, envReused?, envUpAgeMs?, upDurationMs?, seedDurationMs?, testDurationMs?, durationMs? }` — brings the environment up when it is not, runs `seed` when declared, then `test`; the report names the phase that settled it, with per-phase and whole-run durations in milliseconds; `envReused` is true when the run reused an environment an earlier call had already brought up, with `envUpAgeMs` the milliseconds since it finished coming up. The environment stays up afterwards for re-runs. A red test phase whose manifest declared `evidence` or `report` also carries `evidence` — the failed cases, the files found, and everything that went wrong collecting them. With `run_in_background: true` the call instead returns `{ jobId }` immediately — see below. |

For a long suite, `env_test` takes `run_in_background: true`: the whole up → seed → test chain registers as one `ctx.jobs` job (kind `testenv-test`, owned by the calling agent) and the call returns the job id immediately. `job_output` streams phase markers — per-service start/ready, seed and test start/settle — plus the test process's live output (offset-delta reads of the same bounded in-memory tail `env_logs` uses, lossy reads announced), and ends with the exact verdict-first render a synchronous call produces; `job_kill` cancels the run, terminating the current phase's process tree and tearing back down an environment the run brought up itself (an environment reused from an earlier `env_up` stays up, because that call owns it). Job status maps deliberately: a settled run — a red test included — is `completed` with the failure render as its output, `killed` is a cancelled run, and `failed` is reserved for the run itself breaking (an invalid manifest, an engine state that refused the run). `ctx.jobs` is an optional peer service read with `ctx.get`: a composition without it (load `@deepseek-ai/dsh-jobs-local` plus `@deepseek-ai/dsh-tool-jobs`) fails the background call loud instead of silently degrading to the synchronous path.

A missing or invalid manifest turns every tool call into a fail-loud error listing each field-path issue verbatim plus the pointer to the `testenv-bootstrap` skill. Failure attribution is deliberately absent: errors carry the phase, the exit facts, and the log tail, and interpreting them is the model's job. Reads (`env_status`, `env_logs`) present as `generic` cards of kind `read`; the rest are `execute` cards. Presenters are pure functions of arguments.

## Reading a failed run

A red `env_test` renders the failed cases first — each addressed by file and position, with the runner's message and its pre-rendered source snippet — then the evidence files by path, then anything that went wrong collecting them. Screenshots small enough and few enough ride along as image blocks the model can look at; everything else is a path it can open. `error.message` arrives with the runner's terminal colour codes stripped, because a model reading escape sequences sees noise around the words that matter.

Minting an image happens while the tool executes, not while it renders: a tool's render is a pure synchronous function of its canonical value, so a reference the model can look at has to be in that value first. The reference travels as plain JSON, because a canonical tool value must be lossless JSON and the attachment service's own reference is neither.

**The attachment service is optional, and its absence degrades rather than fails.** `ctx.get('attachments')` returning nothing leaves every file reported by path, which is all a model needs to open one. This is deliberately unlike `ctx.jobs`, whose absence fails a background call loud: a caller that asked for a background run is misled by a synchronous one, while a caller reading a failure report loses nothing when an image arrives as a path. The degradation is visible in the value itself — `image` present means the model can see it, absent means it must go read the path — so no single invented reason has to stand in for the several that produce it (no service, an unviewable media type, a file past the size cap, a spent quota, a background job whose output is text).

Both caps report what they dropped. `maxEvidenceImages` is bounded because the harness drops the **oldest** images from a request once its budget is exceeded, so a run attaching dozens of screenshots would evict images the conversation established earlier; a truncated list says how many were found and that the rest are listed by path.

## The bundled skills

`testenv-bootstrap` (bundled, model- and user-invocable, registered at `BUNDLED_SKILL_RANK` so a lower-ranked same-layer provider overrides it by name) owns the judgment half: research how the project's services start — CI configuration first, because a passing integration job already proves its commands, and asking the person you are working with when the repository records it nowhere — write the manifest, prove it, and repair it from the tools' error reports when it rots. An answer given in conversation is a hypothesis like any README claim: a controlled run settles it, and the manifest's provenance comment records that no file corroborates it. The body is an eight-section survey protocol: enumerate every test entry point before choosing a suite (single-suite projects take a fast path), trace each suite's service binding — a fully mocked suite is never `test` — record eliminations and preconditions in the manifest's header comment, prove the `env_up → env_status → env_down` loop, falsify it (with the environment down, the `test` command must turn red), and report the survey in the session.

`testenv-author` (bundled alongside it, same invocation surface and rank) covers the project bootstrap cannot serve — no service-bound suite exists: it derives a service-bound test plan from code evidence — end-to-end or narrower, as the code allows — with every scenario anchored to a source file, writes the tests only after the user approves the plan, and hands back to bootstrap, whose fast path then selects the new suite.

## Configuration

The manifest is project knowledge; everything deployment-varying about executing it is plugin `Config`, validated at load.

| Field | Default | Meaning |
|---|---|---|
| `manifestPath` | `'testenv.yml'` | Manifest path, relative to the workspace root. |
| `readyPollIntervalMs` | `500` | Delay between readiness attempts. |
| `defaultReadyTimeoutMs` | `60000` | Readiness deadline for a service that declares none. |
| `downTimeoutMs` | `30000` | Deadline for a `down` command and for awaiting a terminated tree's exit. |
| `testTimeoutMs` | `600000` | Deadline for the seed and test commands, each. |
| `logTailBytes` | `65536` | In-memory tail cap per captured stream. |
| `graceMs` | `5000` | SIGTERM-to-SIGKILL escalation grace handed to every spawn. |
| `maxEvidenceImages` | `4` | Evidence images carried inline in one failed run; the rest are listed by path. |
| `maxEvidenceFiles` | `50` | Evidence files listed at all, inline or not. |
| `evidenceFileBytesCap` | `10485760` | Largest evidence file worth offering inline. |

## Model Experience

### Tool schemas

#### What the model sees

Five tool schemas whose descriptions carry the manifest contract's consequences: start order and rollback on `env_up`, re-probed health on `env_status`, offset-incremental reads on `env_logs`, aggregated reverse teardown on `env_down`, the up → seed → test ladder on `env_test` — with the steer toward `run_in_background: true` for long suites and the `job_output`/`job_kill` follow-ups — and, on the tools that load the manifest, the pointer to `testenv-bootstrap` when none exists. Results follow the declared output schemas above.

#### Token effect

Fixed schema cost per request while the plugin is active; results are bounded by `logTailBytes` per stream tail and by the per-service report lines.

#### KV Cache effect

Prefix-stable while the plugin scope is unchanged; activation or disposal may invalidate reuse from the tool-schema section onward.

## Known Limitations and Deferred Work

- **One environment per session** — the engine holds at most one running environment; `env_up` while one is up is an error, not a queue. Parallel environments have no current owner.
- **No dependency DAG, parallel startup, port allocation, per-service restart, or automatic retry** — each is excluded for lacking a current owner, not for being hard; the list-shaped manifest keeps a future `dependsOn` additive.
- **`kind: static` is schema-reserved only** — static preview hosting is future work; today the value is a dedicated validation error.
- **`https` readiness probing is unsupported** — local readiness endpoints are served plain, and probing a self-signed dev certificate would force a verification-policy decision no current owner needs.
- **Logs do not survive teardown** — `env_logs` reads captured output until `env_down` (or session end); the durable record is whatever the services themselves write to disk. Evidence files are not logs: the run wrote them to disk itself, so the paths a failure report names stay readable after teardown.
- **JUnit XML is not a `report.format`** — it is the cross-language interchange format, so it is the obvious next one, and it is absent deliberately. It carries case names and messages but no attachments, positions, or snippets — less than the `evidence` globs already deliver — and it is a family of emitter dialects rather than one schema, so implementing it against a single sample would promise more than it could keep. No consumer asks for it yet; the first one brings the multi-emitter fixtures and the XML dependency with it.
- **Evidence is collected only for a red test phase** — a green run reports none, and a failed `up` or `seed` phase reports none either: there is no test run to explain. No current consumer asks for a passing run's trace.
