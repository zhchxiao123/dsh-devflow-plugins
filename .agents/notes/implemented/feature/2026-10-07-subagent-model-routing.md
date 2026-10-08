# Agent Note: Subagent model routing by typed judgement

Status: implemented

## Problem

A delegated subagent runs on whatever model the delegation named, and nothing checks whether that is the right size for the work. Three outcomes follow from the same gap: a mechanical lookup occupies the most expensive model in the deployment, a cross-layer design task gets handed to the cheapest one, and in the common case where the delegation names no route at all the child silently inherits the parent's — a route chosen for the parent's conversation, not for the delegated task.

The harness already has the mechanism for a per-delegation route. `@deepseek-ai/dsh-tool-subagent` with `modelSelectionSettings: true` exposes `provider`, `model`, and `reasoning_effort` on the delegation call and registers `list_subagent_models`. What is missing is a decision-maker: today it is the delegating model's unaided guess, driven by whatever the prompt happens to say.

## Decision

A new Consumer of `ctx.jev`, `@zhchxiao123/dsh-jev-model-router`, decides it from a typed judgement and corrects a disagreeing pick.

**One ordered tier list is the whole configuration surface**, because it is three things at once: the rubric the judgement rates against (`criteria[i] = tiers[i].when`), the table the guidance tells the model to choose from, and the mapping a tier is turned back into a route with. A separate threshold table would have been a fourth description of the same ordering, free to disagree with the other three. The score is probability-weighted and can land between tiers; `Math.round` sends an exactly-halfway value **up**, because under-provisioning costs a wrong result and over-provisioning costs money, which are not the same mistake.

**Guidance is the primary mechanism and the correction is the exception.** Every assembled prompt carries the tier table and the instruction to set a route on each delegation, so a correctly-picking model is never interrupted. The judgement runs at `tools/pre-execute`, where the real delegated prompt is available as evidence, and a pick that disagrees with it is denied once with a reason naming the tier, its exact route, and the situation that tier covers.

**Once, keyed on the prompt.** A corrected delegation is a new call with a new `callId`, so the ledger keys on a digest of the delegated prompt held in a `WeakMap` per agent. A second refusal for the same prompt would turn a routing preference into a dead delegation, so the second attempt proceeds whatever it picked.

**No credential means the gate stands down and the guidance remains.** `ctx.jev.configurationStatus()` reports local configuration only. When it is anything but `configured`, no judgement is made and no delegation is denied: the same decision, made by the model, from the same tier descriptions the judgement would have used. The degraded mode is therefore not a separate code path but the absence of one.

**An inert router says so.** With `list_subagent_models` absent there is no field a correction could ask the model to set, and this package cannot enable one — that is another plugin's load-time configuration, sampled into the session and fixed thereafter. It warns once per load naming what the deployment is missing, rather than failing the mount or silently doing nothing.

### Why a correction rather than an injected route

Neither available seam can set the route behind the model's back, and this is the fact that shaped the whole design.

`tools/pre-execute` cannot rewrite arguments: `ToolExecution.arguments` is readonly and `PreToolDecision` is allow/deny/ask, with the exclusion stated in its own doc comment — the arguments are already logged and presented by the time a listener runs. Runtime mutation of the child's route is closed too: `AgentRuntime.options` is readonly, `agent/pre-step` decides only enter/reject, and `ctx.agentDefaultModel.save()` is global mutable state that would race concurrent creations.

A subagent provider decorator can set `agentOptions`, and for a one-shot start it would work — the service resolves only `mode`/`provider`/`label` into the descriptor before calling the provider, and the in-process driver lets `request.agentOptions` override the parent's route. But `backgroundMode: continuable` defaults `run_in_background` to true, and that path creates the child through the continuation manager, which asks a provider only whether to seed it with parent history. All three stock presets mount the model-selection-enabled `subagent` tool as `continuable`, so a decorator would cover only the explicitly-foreground minority of delegations.

## Alternatives considered

**A subagent provider decorator.** Registers a provider wrapping the real one and fills `agentOptions` when the caller named no route. Hard guarantee, no retry round trip, and invisible to the model. Rejected as the MVP because it misses every `continuable` delegation, which is where the stock presets put them; a deployment would have to switch its `subagent` tool to `backgroundMode: one-shot` and give up continuable children to make it apply, which trades a real capability for a routing preference. It remains additive later — the tier table and the judgement shape need no change — and the condition that would justify it is a deployment that needs routing with model selection off, or one that wants zero-retry certainty on the foreground path.

**Both the decorator and the correction.** Full coverage plus a hard guarantee on the foreground path. Rejected for the MVP because it creates two decision points that can disagree about the same delegation, and doubles the failure modes a reader has to hold.

**A `Choice` question over route names instead of a `Score` over tiers.** Rejected: it writes the deployment's route names into the judgement itself, so changing the model line means re-describing the question. With a Score, the routes are data the code looks up and the rubric stays about the work.

**A configured `defaultTier` applied when the judgement is unavailable.** Carried through planning and dropped during implementation: with no injection point, "apply a tier" can only mean "deny toward it", and denying because the judgement failed contradicts the rule that routing never blocks a dispatch. The field had no coherent consumer, so it does not exist.

**Naming the package `devflow-model-router`.** Rejected: it touches no card, transition, or attempt root, and the `devflow-` prefix would claim a dependency it does not have. It sits with `jev`, `jev-typesafe`, and `jev-triage` as another Consumer of that seam.

**A configurable `scoreInstruction`.** Rejected for now: the tiers already carry the deployment-varying part, and no current consumer needs to reframe what "capability needed" means. Adding it later costs one field.

## Consequences

**Routing is advisory, not enforced.** A model may pick the wrong tier twice and the second attempt proceeds. Under the harness's current seams no mechanism is both complete and hard, and the README says so rather than implying a guarantee.

**One judgement round trip per governed delegation**, bounded by `judgeTimeoutMs` (default 2500) with its own `AbortController` rather than the provider's shared 20-second timeout. The two abort reasons are deliberately distinguishable: the caller's withdrawal returns `withdrawn` and lets the registry's own cancellation recheck report the interrupt as an interrupt, while this router's deadline is an unavailable judgement. The reason is carried as a symbol on the abort rather than read off the error, because every provider reports both as `JEV_ABORTED`.

**Two tiers may not share a route**, and the mount rejects it: a correction naming either tier would be unverifiable from the delegation's own fields.

**`reasoningEffort` is not verified.** A tier is identified by `provider` and `model`; a delegation on the right route with a different effort is not corrected. The effort rides along in the guidance and in the correction text.

**A deployment constraint the code cannot enforce.** The tier routes must not also appear in the delegation tool's `agentOptions`, because that field is what the tool sends when the model named nothing — filling both places makes "the model chose" indistinguishable from "the configuration did". The README carries it; nothing fails if it is violated, the router just stops being able to tell a delegation that needs routing from one already routed.

**Bundle-mounted but disabled.** The tier table has no honest default — the routes are a deployment's own model ids — so the `devflow-bundle` row ships `disabled: true` with the reason, as `devflow-review-gate` and the other opt-in gates do.

## Testing

`tests/gate.spec.ts` drives delegations through the real tool registry so a denial is observed as a model-visible error and an allow is observed as the tool body actually running. The correction budget is tested where it is observable: the same prompt refused once and through on the retry, a different prompt from the same agent still corrected, and the cap evicting its oldest entry.

`tests/judge.spec.ts` separates the two aborts with real `AbortSignal`s rather than a mocked throw, because a mocked cancellation cannot tell which signal fired.

`tests/guidance.spec.ts` asserts the first assembly directly, never arranging a pre-step before it: the published runtime assembles prompt context before that waterfall, so a spec relying on the other order would prove nothing about the first model request.

`tests/loader-composition.spec.ts` boots a `cordis.yml` through the real Loader with the tier list written in YAML, then refuses a delegation and lets the retry through — the two failures unit tests cannot see are a denial the real registry does not materialize and an ordered context the real system-prompt service never asks this package to fill.
