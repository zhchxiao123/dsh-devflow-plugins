# Subagent model router

Routes a delegated subagent to the model tier its task warrants. One ordered tier list serves as the rubric a delegation is rated against, the table the model is told to choose from, and the mapping a tier is turned back into a route with. It consumes `ctx.jev` and knows nothing about which provider answers — compose it with `@zhchxiao123/dsh-jev-typesafe`, or with anything else that provides the seam.

```yaml
- jev-model-router:
    tools: [subagent]
    tiers:
      - key: cheap
        when: 'Mechanical edits and lookups with an already-known answer.'
        provider: deepseek
        model: deepseek-chat
      - key: standard
        when: 'Ordinary implementation or debugging: a few files read, local reasoning.'
        provider: deepseek
        model: deepseek-reasoner
      - key: deep
        when: 'Cross-layer design, concurrency or compatibility changes, or a delivery check where a wrong result is costly.'
        provider: deepseek
        model: deepseek-reasoner
        reasoningEffort: high
```

It needs the delegation tool to expose route fields. Set `modelSelectionSettings: true` on `@deepseek-ai/dsh-tool-subagent` and record a non-empty `subagent-model-selection` route list; without that there is no `provider`/`model` for a model to set, and this router warns once and does nothing.

## How it routes

**Guidance makes naming a route the norm.** Every assembled prompt carries the tier table and the instruction to set `provider` and `model` on each delegation. This is the cheap half: a model that picks correctly is never interrupted.

**A judgement checks each delegation.** The pending delegation's description and prompt become one Score question whose rubric is the tiers themselves, so a tier's own `when` is the only place its level is defined. The score is probability-weighted and can land between tiers; a value exactly halfway rounds **up**, because under-provisioning a hard task costs a wrong result while over-provisioning costs money, and those are not the same mistake.

**A disagreement is refused once.** When the picked route is not the judged tier's — including when no route was named — the call is denied with a reason naming the tier, its exact route, and the situation that tier covers. The model re-issues the same delegation on that route.

Once. Identity is the delegated prompt rather than the tool call id, because a corrected delegation is a new call with a new id; a second refusal for the same prompt would turn a routing preference into a dead delegation, so the second attempt goes through whatever it picked.

## Degraded mode

`ctx.jev.configurationStatus()` reports **local** configuration — whether a credential reference resolves, not whether the remote API is reachable or willing. When it is anything but `configured`, the correction stands down and the guidance remains: the same decision, made by the model, from the same tier descriptions the judgement would have rated against. No delegation is blocked and no judgement call is made.

| Credential | `list_subagent_models` | Behaviour |
|---|---|---|
| configured | visible | guidance, a judgement per delegation, one correction on disagreement |
| unconfigured / unknown | visible | guidance only — the model's own pick, uncorrected |
| either | absent | inert; warns once naming what the deployment is missing |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `tiers` | — required | The tiers, weakest first. At least two — one tier has nothing to discriminate. Each needs `key`, `when`, `provider`, `model`; `reasoningEffort` is optional. Two tiers may not share a route, because a correction naming either one would be unverifiable from the delegation's own fields. |
| `tools` | `['subagent']` | Delegation tool names this router governs. |
| `judgeTimeoutMs` | `2500` | Deadline for one routing judgement. Separate from the provider's own timeout, which is shared with every other consumer of the seam and sized for work no dispatch is waiting on. |

Misconfiguration fails at load, naming the field.

**Do not also put the tier routes in the delegation tool's own `agentOptions`.** That field is what the tool sends when the model named nothing, so filling both places makes "the model chose this" indistinguishable from "the configuration did", and the router can no longer tell a delegation that needs routing from one already routed.

## Why a correction rather than an injected route

Neither available seam can set the route behind the model's back.

`tools/pre-execute` cannot rewrite a call's arguments — they are already logged and presented by the time a policy listener runs, so the decision is allow, deny, or ask. And a subagent provider never sees a background delegation at all: under `backgroundMode: continuable` an omitted `run_in_background` defaults to true, and that path creates the child through the continuation manager, which asks the provider only whether to seed it with parent history. A provider decorator would therefore cover only the explicitly foreground minority of delegations, which is not where the stock presets put them.

So this package does the one thing that covers both paths: judge, and refuse with a reason the model can act on.

## Known limitations

**Not a hard guarantee.** A model may pick the wrong tier twice; the second attempt proceeds. Under the harness's current seams no mechanism is both a hard guarantee and complete — a provider decorator is hard but foreground-only, and a correction is complete but advisory.

**A judgement round trip per governed delegation.** Bounded by `judgeTimeoutMs`, and a timeout allows the dispatch. Judging at dispatch time rather than at prompt assembly is what buys the real delegated prompt as evidence instead of a guess about a delegation not yet written.

**`reasoningEffort` is not verified.** A tier's route is checked against `provider` and `model`; a delegation on the right route with a different effort is not corrected. The two fields identify a tier, and the effort rides along in the guidance and the correction text.

**No routing record.** What was judged and what was corrected lives in session history — the denied tool result is durable and replayable — rather than in a purpose-built log.
