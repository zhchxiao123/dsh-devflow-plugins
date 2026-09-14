# Automation Web

English | [中文](README.zh.md)

Host-scoped management HTTP API for the native Automation sidebar. The scheduler and GitHub sync services remain the owners of plans, runs, snapshots and recovery. Neither service requires this package or the other capability to load.

Load `@zhchxiao123/dsh-automation-web` alongside `@deepseek-ai/dsh-host-webserver` and either optional provider. `trustedHosts` defaults to loopback; configure the same non-loopback authorities as the Harness web face. The trust rule is restated from the published Devflow Web boundary because the Harness implementation is package-internal. This is a browser origin fence, not user authentication.

`POST /automation/api` accepts a strict JSON request (at most 64 KiB). Successful responses are `{ ok: true, data }`; refusals are `{ ok: false, error }`. Fixed domain errors remain actionable; unknown exceptions never expose driver paths or credentials. The host derives the audit actor from the trusted HTTP authority, and caller-supplied actor fields are rejected.

| Method | Input | Result |
| --- | --- | --- |
| `overview` | none | capability availability, plans, triggers, subscriptions, runs, storage |
| `content` | `subscriptionId` | snapshots |
| `plan.save` | optional `id`, `input: PlanInput` | created/updated plan |
| `plan.action` | `id`, `action: pause/resume/remove/trigger/cancel` | trigger receipt or null; cancel targets a trigger ID |
| `subscription.save` | optional `id`, repository, scope and optional credential reference in `input` | subscription; repository identity cannot change |
| `subscription.action` | `id`, `action: pause/resume/sync` | subscription or durable run receipt |
| `run.action` | `id`, `action: cancel/resume` | null or original run receipt |
| `capacity.set` | positive `bytes` | storage usage and audit identity |

Credential inputs accept only `env:VARIABLE` references. Accepted runs are not completed runs: read `overview.runs` for persisted progress and outcomes. External content remains untrusted text for the UI to render. Resume preserves the original run/checkpoint and may be rejected by the provider when scope or newer content changed.

The browser-safe `automationRequest(request, signal?)` export from `./client` validates envelopes and method-specific response data. The owner controls refresh and abort lifetime. Disposing this plugin releases its route and leaves accepted work owned by the providers.

Tests boot real providers, WebServer and the Cordis Loader, then drive HTTP through the browser decoder. Only the external GitHub server is a fixture. Coverage includes trust refusal, schema/body limits, missing capabilities, original-run recovery, actor provenance and route disposal.
