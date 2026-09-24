# TypeSafe Jev provider

Answers `ctx.jev` with [TypeSafe's Jev](https://docs.typesafe.ai) over the System One API. Mounting this row is what registers the seam — `@zhchxiao123/dsh-jev` ships the vocabulary and the base class, and nothing else, so a composition carries this row alone.

```yaml
- jev-typesafe:
    apiKeyRef: TYPESAFE_API_KEY
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `apiKeyRef` | — required | Credential reference naming the API key. Resolved through `ctx.credentials` on **every** call, so a rotated key reaches the next judgement with no restart. There is no default: defaulting it would pick a credential on the deployment's behalf. |
| `baseURL` | `https://api.typesafe.ai` | Endpoint root. Refused if it carries credentials, a query, or a fragment. |
| `model` | `jev-1.13.0` | The model that answers. **A pinned version, not the `jev-latest` alias**: an alias moves when a release ships, and a consumer's confidence thresholds were tuned against whichever model produced them, so a silently newer model reads as drift in the consumer's own data. |
| `timeoutMs` | `20000` | Deadline **per attempt**; retries each get their own. |
| `maxRetries` | `2` | Retries after the first attempt, for rate refusals and server failures. `0` disables retrying. |

Misconfiguration fails at load, naming the field. A reference outside the credential seam's identifier grammar is refused there too, so a typo is a boot failure rather than a capability that is quietly never available.

## Guidance readiness

`configurationStatus()` resolves the configured `apiKeyRef` through the provider-owned Harness credential service. A nonblank value reports `configured`; a missing value or lookup failure reports `unconfigured`. The result contains no credential or error details and makes no remote request. A configured key may still be rejected by the API; ordinary judgement calls retain their existing error classification.

Prompt consumers resolve this status during prompt assembly. Credential changes become visible when the underlying credential provider exposes the new value; changing an external shell environment does not change an already-running process.

## What the SDK owns

`@typesafe-ai/sdk` carries the transport: backoff with jitter, `retry-after` on a rate refusal, per-attempt deadlines, and one error class per failure. It has **no dependencies of its own and issues every request through the global `fetch`**, so a deployment's outbound proxy policy applies to judgements exactly as it applies to the rest of the harness. That property is why this package uses the SDK rather than its own HTTP: a client carrying its own transport would quietly route around the policy.

The client is built per call rather than held. The SDK takes the API key at construction and the seam resolves it per call, so a retained client would pin whichever key was current when the plugin loaded.

## Failure classification

Every failure reaches the caller as `JevError` with a code, because the operator response differs:

| What happened | Code |
|---|---|
| The reference resolves to nothing, or the lookup throws | `JEV_CREDENTIAL_MISSING` |
| The caller withdrew the request | `JEV_ABORTED` |
| The per-attempt deadline elapsed | `JEV_TIMEOUT` |
| Rate refused, and retries were exhausted | `JEV_RATE_LIMITED` |
| Any other non-success status, including a rejected key | `JEV_HTTP_ERROR` |
| The service could not be reached at all | `JEV_UNAVAILABLE` |
| A success whose body carries no answers | `JEV_BAD_RESPONSE` |

A rejected key is `JEV_HTTP_ERROR` and not `JEV_CREDENTIAL_MISSING`: "configured but refused" and "not configured" are different problems with different fixes.

An answer that will not decode is left out of the response rather than reported as a failure, so the seam's rule holds — a question with no readable answer is absent, never a number nobody measured.

## Known limitations

**No batching.** One `ask` is one request. Jev's limits are 64k tokens per request, with the state plus the single longest question bounded at 32k, and staying inside them is the consumer's business — a consumer knows what it can drop, and this package does not.

**`/v1/models` is not called.** A mistyped `model` surfaces as `JEV_HTTP_ERROR` on the first judgement rather than at load.

**English is where the model is strongest.** Other languages, including CJK scripts, are handled but not equally well. Test a non-English workload on your own content before trusting a threshold on it.

**The response fixtures are not recordings.** They were built from the SDK's own type declarations, which are the vendor's machine-readable contract for the same wire but are still not a capture. `tests/fixtures/README.md` records what that leaves uncovered and how to replace them.

## Deployment: outbound proxy

The SDK issues every request through Node's global `fetch`, and Node (≤22 at least) **does not read `https_proxy`/`HTTP_PROXY` by default** — behind an egress proxy with no direct route, every judgement fails as `JEV_UNAVAILABLE` (`ENETUNREACH`) even though `curl` works in the same shell. Set `NODE_USE_ENV_PROXY=1` on the harness process (Node ≥22.15; built-in experimental `EnvHttpProxyAgent`), or install an equivalent global dispatcher before boot. Verified in a relay-proxied container on 2026-09-24, Node 22.23.2:

```sh
# End-to-end reachability, no key needed: the API's own authentication_error proves the path.
curl -sS -i -X POST https://api.typesafe.ai/v1/systemone \
  -H 'content-type: application/json' -d '{}'
#   → HTTP/2 403 …{"detail":{"error_type":"authentication_error",…}}

node -e 'fetch("https://api.typesafe.ai/v1/systemone",{method:"POST"}).then(r=>console.log(r.status)).catch(e=>console.log(e.cause?.code))'
#   → ENETUNREACH        (global fetch ignores the proxy environment)

NODE_USE_ENV_PROXY=1 node -e 'fetch("https://api.typesafe.ai/v1/systemone",{method:"POST"}).then(r=>console.log(r.status)).catch(e=>console.log(e.cause?.code))'
#   → 403                (the same probe reaches the API)
```
