# Real Harness / Jev natural development experiment

This harness mounts published npm Harness `0.1.5-rc.2` services in an isolated Cordis Context and builds this checkout's five Devflow/Jev plugins into that isolated runtime. It calls public agent-loop APIs. It does not modify Harness or monkeypatch the model/tool loop.

Requirements: Node 24, checkout dev dependencies (tsdown), read-only configured `~/.dsh/settings.yaml` and `~/.dsh/.credentials.yaml`. The selected model is recorded in metrics. Credentials are resolved by published credentials-local; they are never copied into experiment files. All runs use fresh local Git fixtures, ephemeral localhost port 0, and a separate DSH_HOME. No 3080 service or installed user profile is changed.

```sh
npm ci --prefix scripts/jev-assistance/runtime --ignore-scripts --no-audit --no-fund
node scripts/jev-assistance/run.mjs off repair
node scripts/jev-assistance/run.mjs observe repair
node scripts/jev-assistance/run.mjs assist repair
```

Run each mode in a separate process when the product source changed. The third argument is `feature` (default; implement archive/restore) or `repair` (repair an existing cache-only implementation that loses archive state after process restart). Within each scenario, baseline source/tests and natural Chinese user request are identical across modes. No prompt mentions JEV.

Budgets: agent 300 seconds, output maxTokens 12000 per model response (not a total-task token cap), Jev 15000 ms per assistance check, 3 judgments and 1 extra steer per turn, confidence floor unchanged at 0.75. Jev transport has 20000 ms timeout, retries 0; assistance abort is the tighter bound. Default model route is deepseek-official/deepseek-flash; actual route is recorded. Jev response model is recorded in each assistance record.

Each run stores provenance (`experiment.json` source SHA256 and lock SHA256), actual event metrics, final response, actual modified Git fixture, assistance records, and the published persistence provider's `session.v3.jsonl.zstd`. The log contains concatenated Zstandard frames; a plain one-frame decoder only shows the header. Use repeated Node `zstdDecompressSync(buffer, {info:true})` and advance by `result.engine.bytesWritten` to read all frames.

Independent acceptance runs outside the agent fixture and opens a new Node process for every create/archive/list/restore operation. It checks process-restart persistence, hidden archived tasks, includeArchived, preserved id/title, missing-id errors, and idempotence. Agent-written tests cannot replace this acceptance.

This is independent execution, not a blind test or a filesystem sandbox. Historical agents could and sometimes did read the acceptance script outside their fixture. Its hash remained unchanged. The historical acceptance has ten explicit assertions; it does not assert state immediately after the repeated archive operation or grade error-message clarity. See the committed report for those limits.

Run `node scripts/jev-assistance/summarize.mjs <evidence-directory>` to extract time, repeated failures, subsequent edit rounds, corrections after failed checks and acceptance assertions from complete session logs. These are observable operation counts, not causal rework savings. Missing evidence causes an error rather than a zero count; intervention necessity remains unknown without a separate assessment.

Interpretation: one run per mode is a plumbing/behavior sample, not a causal or statistical efficacy estimate. `continue` in assist means no advice was delivered. Local `budget-exhausted` records are not remote Jev calls. Currency cost is unknown; missing provider token usage remains unknown. A later test pass never establishes advice adoption or causality. Baseline/repair model mistakes and no-benefit runs must be retained.

`repair-draft` adds the cache-only draft as uncommitted code and asks to finish it. `repair-review` uses the same actual draft but asks for delivery review without pre-announcing its persistence bug. These are diagnostic assist-only scenarios, not extra randomized efficacy comparisons.

Source is a standalone Node ESM experiment, outside the production TypeScript project and bundles. Validate its syntax with `node --check scripts/jev-assistance/run.mjs` and `node --check scripts/jev-assistance/summarize.mjs`. Runtime dependencies are installed only in this script directory. Raw runs and node_modules are intentionally gitignored; the checked-in report preserves results and provenance while local scratch retains full original evidence.

`node scripts/jev-assistance/run.mjs assist contract-failure` runs a separately labeled controlled integration contract. A published pre-step hook at the second checkpoint calls the real ToolRuntime twice on the same failing persistence test, verifies nonzero exit codes, and forwards the actual bounded failure output to the agent. It never accesses private observer state or replaces the provider. This is controlled failure injection, not a natural efficiency sample.
