# Agent Note: Bounded JEV assistance for Devflow development

Status: implemented

## Problem

Prompt guidance makes JEV discoverable but leaves every invocation to the agent. During development, repeated failures and missing verification can go unnoticed even though local tool results and checkout changes provide enough evidence to ask a bounded question. Recording a judgement alone also leaves users unable to distinguish observation, delivery and actual outcomes.

## Decision

Three existing packages participate. The devflow-jev package owns the assistance service, configuration, policy, workspace evidence collector and durable record store. The generic jev runtime adds optional configurationIdentity() metadata for consumer cache invalidation. The TypeSafe provider implements it as an opaque fingerprint of provider, model, endpoint and credential reference, excluding credential values. This identifies configuration, not provider health or secret rotation behind an unchanged reference. Published Harness tool-result and agent lifecycle hooks observe recognized development events. The service asks the existing provider-neutral JEV seam at bounded checkpoints and can supply advice to the current agent. It never executes development commands, advances a card, or relaxes a validator.

The default mode is observe: collect eligible evidence and record judgements without delivering them. Assist enables delivery through the current agent; off disables automatic hooks while preserving the explicit tools and existing guidance. Per-turn calls and corrective steers, judgement deadlines, confidence thresholds and evidence byte/file limits belong to validated configuration. Recognized tool observations do not constitute support for arbitrary tool protocols.

Policy version 3 chooses a concrete investigation target from supplied requirements or actual failed tool outcomes, while explicitly leaving the suggestion unverified. It records the raw model action separately from threshold disposition and retains a scope choice when attribution is uncertain. A natural-language request and read-only shell preparation alone do not spend remote judgement budget. Completed design artifacts, real post-baseline edits, repeated failures and completion remain eligible checkpoints. With a call budget of at least two, intermediate checkpoints reserve the final call for completion or repeated failure. Deduplication permits a fresh assessment after switching from observe to assist or restoring local credential configuration, subject to remaining budgets; delivered and delivery-uncertain records remain protected from replay for the same evidence, event, policy version and provider configuration identity.

Evidence identifies the actual checkout and observed session. Card association requires supported successful tool evidence and ownership checks; ambiguity or unverified dispatched-worktree association retains session scope. Bounded git/source evidence and tool results carry explicit gaps. Untrusted evidence cannot supply executable commands or authorize actions. Stage assessments consume their relevant typed answers rather than reusing intake scores as release permission.

The collector preserves the canonical session directory rather than expanding it to the Git repository root. It records a local per-turn identity baseline so unchanged pre-existing dirty files do not dominate later requests; snapshot metadata is excluded from provider evidence. Safe large source files can retain a bounded diff even when full excerpts are omitted. Hidden, sensitive, unsafe and binary paths remain excluded with explicit gaps. Supplied files use content hashes; excluded paths can contribute opaque local metadata/index fingerprints without exposing content. Truncated enumeration, unreadable metadata or concurrent changes make the observation non-reusable. This separation permits bounded advice without treating partial coverage as complete verification.

Records live under `.devflow/judgements/assistance/`. A record separates trigger, raw/selected action and disposition from delivery status and observed outcome. It also preserves action-choice concentration and intervention-support probability separately. Stale reasons identify the changed provider, activity, evidence, task, workspace or tools. Unbound card reasons are recorded instead of guessing ownership. Subsequent observed action/check details include the actual tool call ID and available exit status; these references establish observation, not causation. Persistence precedes publication; an uncertain delivery is not blindly replayed after restart. Cancellation, stale evidence, missing credentials and budget exhaustion remain visible outcomes of the assistance attempt. The Devflow journal remains authoritative for card state.

The existing source registry exposes read-only devflow-assistance through jev_list. Trusted HTTP queries derive the project from the supplied session instead of accepting a filesystem root. The existing JEV panel adds an Automatic assistance filter and details, searchable by associated card ID, title, session ID and reason. Actionable and delivered advice remains visible; no-op and stale diagnostics are collapsed by default and can be expanded. A stale record is labeled invalid rather than rendered as live advice. The view shows evidence references and gaps rather than the full collected source. It does not embed a timeline inside Devflow card details.

## Alternatives considered

**Prompt guidance alone.** It remains useful and stays enabled independently, but it does not create persistent records from observed development events.

**A separate executor or mandatory semantic gate.** Either would duplicate Harness ownership or turn probabilistic advice into permission to move workflow state. Assistance instead gives the current agent bounded advice and retains existing gates.

**A new family of model tools and packages.** The existing source registry, project HTTP route and review panel already own query and presentation. Extending them keeps one lifecycle vocabulary and avoids another orchestration surface.

## Consequences

Observe mode supports evaluating intervention quality before enabling delivery, at the cost of judgement latency and provider usage for eligible events. Assist is advisory and remains dependent on the agent choosing an appropriate action. Unknown outcomes stay unknown; later actions and checks cannot prove adoption, causation or resolution merely because they happened after a suggestion.

Deterministic UI, transport and composition tests establish record visibility, project isolation, optional-service lifecycle and the distinction between delivery and outcome. They do not prove TypeSafe availability, natural task success or a general development-speed improvement. Those require separate runtime and comparative evidence, including unsuccessful or unhelpful interventions.

Acceptance retains the repository's per-file coverage gate, including existing review and audit surfaces. Tests exercise real cancellation and durable recovery; fabricated engine states cannot establish those contracts. The shared engine owns result callbacks and cancellation, so the Devflow adapter reuses loaded checkpoints and preserves cancellation instead of converting it into provider unavailability. Comparative reports distinguish independently executed acceptance from blind testing, and observed edit rounds from causal rework savings.
