# Devflow task cards

English | [中文](devflow.zh.md)

Types shared by the file-backed task-card seam and its consumers. The [devflow Agent Note](../../.agents/notes/implemented/feature/2026-08-25-devflow-file-based-task-cards.md) owns the seam decisions; this page records the exact fields and variants from [`packages/devflow/src/types.ts`](../../packages/devflow/src/types.ts).

## Identity and stages

`DevflowCardId` is a [branded id](core.md#branded-ids) equal to the card's directory name (`<seq>-<slug>`), stable from creation. `DevStage` is the closed pipeline union; `blocked` is a bypass location, not a stage, and a blocked card remembers the stage it interrupted.

```ts type-equiv
/**
 * The closed set of pipeline stages a card moves through. `blocked` is not a
 * stage: it is a bypass location that remembers the stage it interrupted (see
 * {@link CardLocation}).
 */
type DevStage =
  | 'draft'
  | 'designing'
  | 'ready'
  | 'developing'
  | 'reviewing'
  | 'testing'
  | 'done'
```

```ts type-equiv
/** Where a card currently sits: a pipeline stage, or the `blocked` bypass. */
type CardLocation = DevStage | 'blocked'
```

## Journal entries

The append-only journal is the authoritative card history; the card file's frontmatter is a rebuildable projection. `decodeJournalEntry` validates each parsed line at the durable boundary, and `foldJournal` enforces contiguous revisions from 1, `created` first and only first, transitions departing the current location, and exact blocked recovery.

A requirement too big for one card becomes a parent card plus one child card per slice. The edge is the `created` entry's `parent`, fixed at creation and never re-pointed; it folds into `DevCard.parent`, projects as the frontmatter `parent:`, and narrows reads through `CardFilter.parent`. The breakdown is one level deep and never crosses roots — the provider enforces both when a child is created (`unknown-parent`, `nested-parent`, `parent-settled`).

```ts type-equiv
/** Who performed a journal action; `command` marks the human-command intervention plane. */
type DevActor =
  | { kind: 'human'; name?: string }
  | { kind: 'agent'; session?: string }
  | { kind: 'command'; name?: string }
```

```ts type-equiv
/** First journal entry of every card; `rev` is always 1. */
interface JournalCreated {
  rev: number
  at: string
  type: 'created'
  by: DevActor
  /** The card this one decomposes, fixed here at creation and never changed. */
  parent?: DevflowCardId
}
```

```ts type-equiv
/**
 * One recorded gate verdict on a committed transition: which actor allowed the
 * move and, optionally, what the check covered. Only permitting verdicts
 * exist — a refusal vetoes the transition instead of being recorded.
 */
interface GateCheck {
  /** The actor that allowed the move. */
  by: DevActor
  verdict: 'allowed'
  /** One-line account of what the check covered. */
  summary?: string
}
```

```ts type-equiv
/**
 * One stage move. A move to `blocked` remembers `from`; the matching recovery
 * must return to exactly that stage.
 */
interface JournalTransition {
  rev: number
  at: string
  type: 'transition'
  from: CardLocation
  to: CardLocation
  by?: DevActor
  reason?: string
  /**
   * Gate facts attached by the transition waterfall: the human approval
   * signature and/or the recorded gate verdicts. At least one is present —
   * a move nothing gated carries no `gate` at all.
   */
  gate?: { approvedBy?: DevActor; checks?: GateCheck[] }
}
```

```ts type-equiv
/** Registration of a stage deliverable produced under `artifacts/`. */
interface JournalArtifact {
  rev: number
  at: string
  type: 'artifact'
  path: string
  stage: DevStage
  by?: DevActor
  /**
   * Deliverable kind of a store-written artifact; absent for a path-only
   * registration and for entries predating kinds.
   */
  kind?: string
}
```

```ts type-equiv
/** Takeover of a stale lease: the previous holder's heartbeat lapsed. */
interface JournalClaimExpired {
  rev: number
  at: string
  type: 'claim-expired'
  previousOwner: DevActor
  by: DevActor
}
```

```ts type-equiv
/** The journal entry union; the discriminant is `type`. */
type DevflowJournalEntry = JournalCreated | JournalTransition | JournalArtifact | JournalClaimExpired
```

## Read values

```ts type-equiv
/**
 * Read-side value of one artifact registration: the journal entry's facts
 * without its envelope. Registrations are immutable — the newest record of one
 * `kind` (the highest `rev`) is that kind's current content.
 */
interface ArtifactRecord {
  /** Artifact path relative to the card directory. */
  path: string
  /** Deliverable kind; absent for a path-only registration. */
  kind?: string
  /** Journal revision of the registration; orders records of one kind. */
  rev: number
  /** The stage the deliverable was registered against. */
  stage: DevStage
}
```

```ts type-equiv
/** Read-side value of one card, current state derived by journal replay. */
interface DevCard {
  id: DevflowCardId
  /** Resolved devflow root directory this card belongs to (absolute path). */
  root: string
  /** Human title from the card file's frontmatter. */
  title: string
  /** Current location derived from the journal, never from the frontmatter projection. */
  stage: CardLocation
  /** Revision of the last journal entry; optimistic-concurrency token for transitions. */
  stageRevision: number
  /** The stage a `blocked` card returns to on recovery; absent unless `stage` is `blocked`. */
  blockedFrom?: DevStage
  /**
   * The card this one decomposes; absent for a top-level card. Only one level
   * exists, so a card carrying `parent` is never itself a parent.
   */
  parent?: DevflowCardId
  /** Markdown body of the card file below its frontmatter. */
  body: string
  /** Display path of the card file. */
  path: string
  /** Artifact paths registered in the journal, in registration order; the path projection of {@link artifactRecords}. */
  artifacts: string[]
  /** Artifact registrations in registration order, each carrying its journal revision, registering stage, and optional kind. */
  artifactRecords: ArtifactRecord[]
}
```

```ts type-equiv
/** Read filter accepted by {@link import('./index.ts').DevflowStore.list}. */
interface CardFilter {
  /** Only cards currently at this location. */
  stage?: CardLocation
  /** Only cards decomposing this one; an id with no children matches nothing. */
  parent?: DevflowCardId
}
```

## Service behavior

The abstract [`DevflowStore`](../../packages/devflow/src/index.ts) Service Definition specifies journal-authoritative `list`/`read` with fail-loud invalid journals and warn-and-override projection drift, the explicit `resolveCreate`/`resolve` request/spec splits, the `create` path (sequence allocation past archived cards → exclusive directory creation → the journal's first `created` entry as the only commit point → projection write → `devflow/card-created`), the `transition` pipeline (revision CAS → edge legality → the `devflow/transition` waterfall → journal append as the only commit point → projection rewrite → `devflow/stage-changed`), and the exclusive `claim` lease. [`FilesystemDevflowStore`](../../packages/devflow-filesystem/src/index.ts) is the file Service Provider; [`dsh-tool-devflow`](../../packages/devflow-tool/README.md) is the model-facing Consumer and [`dsh-devflow-gates`](../../packages/devflow-gates/README.md) the gate policy on the waterfall — command gates plus one-shot human approvals over the interaction plane, with unreachable-responder moves parked `blocked` for a human. [`dsh-devflow-fs-guard`](../../packages/devflow-fs-guard/README.md) denies the agent file tools' mutations under the protected state directories on the `fs/*` intent waterfalls, keeping that executor the only write path over the card history. [`dsh-devflow-parent-gate`](../../packages/devflow-parent-gate/README.md) is the completion policy on the same waterfall — a decomposed requirement reaches `done` only after every child card does, which leaves the parent's own `reviewing` and `testing` for the integration pass. [`dsh-devflow-artifact-gate`](../../packages/devflow-artifact-gate/README.md) is the artifact-contract policy on the same waterfall — a configured edge requires registered artifact kinds whose newest registration passes a mechanical frontmatter-and-sections check, with the kind specs published as the read-only `devflowArtifactSpecs` service for producers to template against. [`dsh-devflow-agent-gate`](../../packages/devflow-agent-gate/README.md) is the LLM admission policy on the same waterfall — a configured edge dispatches an independent one-shot checker subagent over the card and its newest input artifacts, records an allow in the committed entry's `gate.checks`, writes each veto's full report under `reportDir`, fails closed (veto plus a `blocked` park) on any checker fault, and reuses cached verdicts for identical retries instead of re-dispatching. [`dsh-devflow-driver`](../../packages/devflow-driver/README.md) claims stage work on `devflow/stage-changed` and drives it through subagent executors, skipping cards that decompose into children so a requirement never becomes one child's objective; [`dsh-command-devflow`](../../packages/devflow-command/README.md) is the deterministic `/devflow` intervention plane — board and card views, moves through the same executor (gates still decide), forced lease takeover, and `archiveDone` archiving; [`dsh-devflow-web`](../../packages/devflow-web/README.md) is the browser channel — a read-only session-scoped JSON route plus a change stream on the harness webserver, owned by the plugin line rather than by any framework forwarding face — and [`dsh-client-ui-devflow`](../../packages/devflow-ui/README.md) renders the board read-only over it, as a sidebar page where a sidebar foundation is composed and a floating session-header control everywhere else.

## The artifact contract

A deployment that wants artifact discipline on the pipeline composes it from the four transition policies plus the driver — no policy hardcodes a contract, so the whole thing is configuration. The sample below is the devflow half of a profile (the harness's shell executor, subagent runtime, and default-model rows are composed as usual) and every pipeline edge carries a contract; [`tests/artifact-contract-composition.spec.ts`](../../tests/artifact-contract-composition.spec.ts) boots this composition shape through the real Loader and drives one card draft→done across it.

**Load order is the waterfall.** Listeners on `devflow/transition` run in registration order, so the mount order of the four policies is the decision order, and the sample's order is deliberate: **mechanical → agent → command → approval/completion**, cheapest and most deterministic first. The free structure check vetoes before a checker spends model budget on an incomplete deliverable; the checker vetoes before a command gate spends a test suite's wall-clock on unsound work; commands run before a human is asked; and the human is only asked once every automatic layer has said yes. The [bundle](../../packages/devflow-bundle/README.md) mounts its policy rows in exactly this order, and the composition test asserts it holds — a mechanical defect dispatches zero checkers and runs zero gate commands.

**Kinds are defined at one point.** The `specs` section of `devflow-artifact-gate` is the only place a kind's structure exists; it is also published as the read-only [`devflowArtifactSpecs`](#ctxdevflowartifactspecs--artifactspecs-value-service) service. Everything else names kinds without restating their shape: the agent gate's `inputs` and the driver's `inputs` pin which registrations feed a check or a child prompt, and the driver's `produces` renders its production template from the service — so the template a producer writes against and the spec the gate checks cannot drift apart.

```yaml
# The store, then the four policies in waterfall order, then the driver.
- name: '@zhchxiao123/dsh-devflow-filesystem'

# Layer 1 — mechanical artifact contract. `specs` is the single definition of
# every kind; `edges` says which kinds each edge requires. All six pipeline
# edges carry a contract here.
- name: '@zhchxiao123/dsh-devflow-artifact-gate'
  config:
    specs:
      prd:
        frontmatter: [card]
        sections: [Requirements, 'Acceptance Criteria']
      design:
        frontmatter: [card]
        sections: [Approach, Compatibility]
      implement:
        sections: [Changes, Verification]
      review:
        sections: [Findings, Verdict]
      test-report:
        sections: [Coverage, Results]
    edges:
      'draft->designing': [prd]
      'designing->ready': [prd, design]
      'ready->developing': [prd, design]   # still on disk when work begins
      'developing->reviewing': [implement]
      'reviewing->testing': [review]
      'testing->done': [test-report]

# Layer 2 — agent admission. Inputs name kinds; the checker reads their
# newest registrations. Requiring their presence stays layer 1's job.
- name: '@zhchxiao123/dsh-devflow-agent-gate'
  config:
    edges:
      'designing->ready':
        provider: claude
        inputs: [prd, design]
        prompt: Verify the design covers every acceptance criterion of the PRD.
      'reviewing->testing':
        provider: claude
        inputs: [implement, review]
        prompt: Verify the implementation answers every review finding.
    reportDir: .devflow/reports
    verdictCacheDir: .devflow/verdict-cache

# Layer 3 — command gates, plus the one human approval: releasing work into
# development, the point where the driver starts spending model budget.
- name: '@zhchxiao123/dsh-devflow-gates'
  config:
    edges:
      'developing->reviewing': ['pnpm run verify']
    approvals: ['ready->developing']
    policies:
      'developing->reviewing':
        timeoutMs: 600000

# Layer 4 — completion: a decomposed requirement reaches done only after
# every child card does. No config; the rule is the relation.
- name: '@zhchxiao123/dsh-devflow-parent-gate'

# The producer. Each driven stage feeds the newest registrations of its
# `inputs` into the child prompt and instructs the child to register its
# `produces` kind — templated from the devflowArtifactSpecs service.
- name: '@zhchxiao123/dsh-devflow-driver'
  config:
    stages:
      designing:
        provider: claude
        inputs: [prd]
        produces: design
      developing:
        provider: claude
        inputs: [design, review]
        produces: implement
      reviewing:
        provider: claude
        inputs: [implement]
        produces: review
      testing:
        provider: claude
        inputs: [implement]
        produces: test-report
    maxConcurrentCards: 2
```

The rework loop needs no extra wiring: a veto leaves the card in place with the reason (an agent veto's full report lands under `reportDir`), the producer registers a fixed revision of the same kind, and the retry re-checks against that newest registration — the agent gate re-dispatches because the changed input revision misses its verdict cache, while a retry with nothing changed reuses the cached verdict instead of paying a second checker.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` — **which this repository does not carry**: the generator stayed in the harness when this line was extracted, so the block below is maintained by hand against the JSDoc in `packages/*/src` until the script is ported. Treat the source as the authority on any disagreement. The language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdevflow--devflowstore-abstract-seam"></a>

### `ctx.devflow` — `DevflowStore` (abstract seam)

Abstract task-card store registered as `ctx.devflow` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). Subclass, implement the abstract methods, and load the subclass as a plugin.

Implementations must honor these read-side semantics:

- Current state comes from journal replay (foldJournal); the card file's frontmatter is a projection. On disagreement the journal wins and the drift is warned, never silently adopted.
- A structurally invalid journal fails the read loudly, naming the file and line; a card is never silently skipped.

```ts cordis-catalog
/**
 * List the cards in the active set of one root.
 * @param filter - optional narrowing; omitted lists every card.
 * @param root - devflow root to list; omitted uses the implementation's default root.
 * @returns cards ordered by id.
 */
abstract list(filter?: CardFilter, root?: string): Promise<DevCard[]>

/**
 * Read one card.
 * @param id - the card id (its directory name).
 * @param root - devflow root holding the card; omitted uses the implementation's default root.
 * @returns the card with journal-derived current state.
 */
abstract read(id: DevflowCardId, root?: string): Promise<DevCard>

/**
 * Read one card's complete decoded journal, in revision order. The stream
 * is validated like a read: a structurally invalid journal fails loudly,
 * naming the file and line.
 * @param id - the card id (its directory name).
 * @param root - devflow root holding the card; omitted uses the implementation's default root.
 * @returns the decoded entries, oldest first.
 */
abstract history(id: DevflowCardId, root?: string): Promise<DevflowJournalEntry[]>

/**
 * Read the card's current lease holder.
 * @param id - the card id (its directory name).
 * @param root - devflow root holding the card; omitted uses the implementation's default root.
 * @returns the holder facts, or `undefined` while the card is unclaimed; a
 *   corrupt claim record fails loudly.
 */
abstract holder(id: DevflowCardId, root?: string): Promise<ClaimHolder | undefined>

/**
 * Apply implementation-owned defaults to a creation request: the slug when
 * omitted, the devflow root when omitted, and the creation timestamp.
 * @param request - the caller's request.
 * @returns the fully specified spec to hand to {@link create}.
 */
abstract resolveCreate(request: CreateRequest): CreateSpec

/**
 * Create one card in the active set: sequence-number allocation, the
 * exclusive card-directory creation, the journal's first `created` entry
 * (the only commit point), the projection write, then `devflow/card-created`.
 * Sequence numbers continue past archived cards, so an id is never reissued.
 * @param spec - a resolved spec from {@link resolveCreate}, never a raw request.
 * @returns the outcome; domain rejections resolve with `ok: false`.
 */
abstract create(spec: CreateSpec): Promise<CreateResult>

/**
 * Apply implementation-owned defaults to a transition request: the devflow
 * root when omitted and the commit timestamp.
 * @param request - the caller's request.
 * @returns the fully specified spec to hand to {@link transition}.
 */
abstract resolve(request: TransitionRequest): TransitionSpec

/**
 * Commit one stage move: revision check, edge check, the
 * `devflow/transition` waterfall, the journal append (the only commit
 * point), the projection rewrite, then `devflow/stage-changed`. State and
 * notifications publish only after the journal committed.
 *
 * The waterfall's gate commands put real time between those checks and the
 * append, so implementations must re-establish the checked revision at the
 * append itself, under an exclusion another process observes. A card that
 * moved in that window resolves `revision-mismatch`; a card whose commit
 * stayed excluded resolves `write-contended` with nothing written.
 * @param spec - a resolved spec from {@link resolve}, never a raw request.
 * @returns the outcome; domain rejections resolve with `ok: false`.
 */
abstract transition(spec: TransitionSpec): Promise<TransitionResult>

/**
 * Take the card's exclusive lease. A stale takeover journals the eviction
 * under the same cross-process commit exclusion as transitions and artifact
 * registration, so concurrent takeover attempts grant at most one holder.
 * @param id - the card to claim.
 * @param owner - the prospective holder, recorded in the lease.
 * @param options - staleness takeover policy and root; omitted never takes
 *   over and uses the implementation's default root.
 * @returns the live handle, or a holder read from the lease. On journal-commit
 *   contention that holder was observed before trying the lock, not freshly
 *   established as the current owner.
 */
abstract claim(id: DevflowCardId, owner: DevActor, options?: ClaimOptions): Promise<ClaimResult>

/**
 * Register a stage deliverable in the card's journal against its current
 * stage, in one of two mutually exclusive forms: the reference form records
 * a `path` the caller already wrote under the card directory, and the
 * store-written form hands over `kind` plus `content` for the
 * implementation to write `artifacts/<rev>-<kind>.md` itself before the
 * journal append — which stays the only commit point, so a registration
 * that loses the commit registers nothing and its unreferenced file is
 * overwritten by a same-revision retry. Registrations are immutable: the
 * newest record of one kind is that kind's current content. A blocked or
 * done card cannot register artifacts, the revision check mirrors
 * {@link transition}, and an ill-formed kind resolves `invalid-kind`.
 * @param request - card, expected revision, actor, and the artifact reference or content.
 * @returns the outcome carrying the registered record; domain rejections resolve with `ok: false`.
 */
abstract attachArtifact(request: ArtifactRequest): Promise<ArtifactResult>

/**
 * Move every `done` card of one root out of the active set into that root's
 * archive, keyed by the month of its last journal entry. Archived cards
 * leave {@link list} but keep their complete journal.
 * @param root - devflow root to archive; omitted uses the implementation's default root.
 * @returns the archived card ids, in id order.
 */
abstract archiveDone(root?: string): Promise<DevflowCardId[]>

/**
 * {@link list} scoped to a viewing session's workspace, the face every
 * browser channel reads through.
 * @param filter - optional narrowing; omitted lists every card.
 * @param sessionId - the viewing session; its workspace resolves host-side
 *   to the devflow root, so the wire never carries a file path. Omitted
 *   lists the default root.
 * @returns cards ordered by id.
 */
async listForSession(filter?: CardFilter, sessionId?: string): Promise<DevCard[]>

/**
 * One card's detail scoped to a viewing session's workspace: the read value,
 * its complete decoded journal, and the current lease holder in one round
 * trip.
 * @param id - the card id (its directory name).
 * @param sessionId - the viewing session; resolved like {@link listForSession}.
 * @returns the aggregated detail; `holder` is absent while the card is unclaimed.
 */
async detailForSession(id: DevflowCardId, sessionId?: string): Promise<DevCardDetail>
```

Source: [`packages/devflow/src/index.ts`](../../packages/devflow/src/index.ts)

<a id="ctxdevflowartifactspecs--artifactspecs-value-service"></a>

### `ctx.devflowArtifactSpecs` — `ArtifactSpecs` (value service)

Read-only kind-spec table published by `dsh-devflow-artifact-gate`, registered for the plugin's fiber lifetime and gone when it disposes. Optional service: read it with `ctx.get('devflowArtifactSpecs')`, never the property proxy — a deployment without the gate simply has no specs to template against.

```ts cordis-catalog
/**
 * The gate's configured kind specs, published read-only so a producer can
 * shape a deliverable to the same spec the gate will check. Optional
 * service: read it with `ctx.get('devflowArtifactSpecs')`.
 */
devflowArtifactSpecs: ArtifactSpecs

/**
 * Value of the `devflowArtifactSpecs` service: the configured specs, deep
 * frozen and normalized (empty lists dropped).
 */
type ArtifactSpecs = { readonly [kind: string]: ArtifactKindSpec }

/**
 * Structural requirements of one artifact kind. Both lists are optional and an
 * empty list equals omission; a kind declared with neither is required only to
 * be registered. The lists stay mutable in type for the config validator's
 * sake; the published service value is deep frozen regardless.
 */
interface ArtifactKindSpec {
  /**
   * Frontmatter fields the artifact must carry, each present with a value —
   * a key mapped to nothing counts as missing.
   */
  frontmatter?: string[]
  /** Second-level section titles (without the `## ` prefix) the artifact must contain. */
  sections?: string[]
}
```

Source: [`packages/devflow-artifact-gate/src/types.ts`](../../packages/devflow-artifact-gate/src/types.ts)

<a id="devflow-events"></a>

### `devflow/*` events

<a id="devflowcard-created--emit"></a>

#### `devflow/card-created` — emit

A new card entered the active set: its journal committed the first `created` entry. Dispatched once per creation, after the projection write.

```ts cordis-catalog
/**
 * A new card entered the active set: its journal committed the first
 * `created` entry. Dispatched once per creation, after the projection
 * write.
 * @mode emit
 * @param card - the created card, at `draft` with revision 1.
 */
'devflow/card-created'(card: DevCard): void
```

Source: [`packages/devflow/src/types.ts`](../../packages/devflow/src/types.ts)

<a id="devflowstage-changed--emit"></a>

#### `devflow/stage-changed` — emit

A card settled at a new location after a committed transition.

```ts cordis-catalog
/**
 * A card settled at a new location after a committed transition.
 * @mode emit
 * @param card - the card after the move, `stageRevision` already advanced.
 * @param from - the location the card departed.
 */
'devflow/stage-changed'(card: DevCard, from: CardLocation): void
```

Source: [`packages/devflow/src/types.ts`](../../packages/devflow/src/types.ts)

<a id="devflowtransition--waterfall"></a>

#### `devflow/transition` — waterfall

Single-decision transition pipeline. The store dispatches this after the revision and edge checks and before the journal commit; a policy listener that owns the decision returns `{ allowed: false, reason }` without calling `next()`, while an observing listener must delegate.

```ts cordis-catalog
/**
 * Single-decision transition pipeline. The store dispatches this after the
 * revision and edge checks and before the journal commit; a policy
 * listener that owns the decision returns `{ allowed: false, reason }`
 * without calling `next()`, while an observing listener must delegate.
 * @param attempt - the resolved transition about to commit, including its departure location.
 * @param next - delegate to the remaining listeners, finally `{ allowed: true }`.
 * @mode waterfall
 */
'devflow/transition'(attempt: TransitionAttempt, next: () => Promise<TransitionDecision>): Promise<TransitionDecision>
```

Source: [`packages/devflow/src/types.ts`](../../packages/devflow/src/types.ts)
<!-- END GENERATED cordis-surface -->
