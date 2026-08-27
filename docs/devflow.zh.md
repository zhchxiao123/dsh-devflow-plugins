# Devflow 任务卡

[English](devflow.md) | 中文

文件任务卡缝及其消费者共享的类型。[devflow Agent Note](../../.agents/notes/implemented/feature/2026-08-25-devflow-file-based-task-cards.zh.md) 拥有缝的决策；本页记录 [`packages/devflow/src/types.ts`](../../packages/devflow/src/types.ts) 中的确切字段与变体。

## 身份与阶段

`DevflowCardId` 是等于卡片目录名（`<seq>-<slug>`，创建后不变）的 [branded id](core.zh.md#branded-ids)。`DevStage` 是闭合的流水线联合；`blocked` 是旁路位置而非阶段，blocked 的卡记住被打断的阶段。

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

## Journal 条目

追加式 journal 是权威的卡片历史；卡片文件的 frontmatter 是可重建的投影。`decodeJournalEntry` 在持久化边界校验每个已解析的行，`foldJournal` 强制 revision 从 1 连续、`created` 必须且只能是首条、transition 必须从当前位置出发、blocked 精确恢复。

一张卡装不下的大需求拆成一张父卡加每个切片一张子卡。这条边是 `created` 条目的 `parent`，创建时固定、永不改指；它折叠为 `DevCard.parent`、投影为 frontmatter 的 `parent:`、并通过 `CardFilter.parent` 收窄读取。拆分只有一层且从不跨根——两者都由 provider 在创建子卡时强制（`unknown-parent`、`nested-parent`、`parent-settled`）。

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
  /** Gate facts attached by the transition waterfall, e.g. the human approval signature. */
  gate?: { approvedBy: DevActor }
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

## 读值

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
  /** Artifact paths registered in the journal, in registration order. */
  artifacts: string[]
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

## 服务行为

抽象的 [`DevflowStore`](../../packages/devflow/src/index.ts) Service Definition 规定 journal 权威的 `list`/`read`（journal 非法则读取 fail-loud，投影漂移告警并覆盖）、显式的 `resolveCreate`/`resolve` request/spec 拆分、`create` 路径（越过归档卡的顺序号分配 → 独占目录创建 → journal 首条 `created` 作为唯一提交点 → 投影写入 → `devflow/card-created`）、`transition` 管线（revision CAS → 边合法性 → `devflow/transition` waterfall → journal 追加作为唯一提交点 → 投影重写 → `devflow/stage-changed`）与独占 `claim` 租约。[`FilesystemDevflowStore`](../../packages/devflow-filesystem/src/index.ts) 是文件 Service Provider；[`dsh-tool-devflow`](../../packages/devflow-tool/README.zh.md) 是模型侧 Consumer，[`dsh-devflow-gates`](../../packages/devflow-gates/README.zh.md) 是 waterfall 上的门禁策略——命令门禁加经交互面的一次性人工审批，应答者不可达的移动停驻 `blocked` 等人。[`dsh-devflow-fs-guard`](../../packages/devflow-fs-guard/README.zh.md) 在 `fs/*` intent waterfall 上拒绝 agent 文件工具对受保护状态目录的变更，使该执行器保持卡片历史的唯一写路径。[`dsh-devflow-parent-gate`](../../packages/devflow-parent-gate/README.zh.md) 是同一 waterfall 上的完成策略——拆分需求只有在每张子卡都完成后才能到达 `done`，从而把父卡自己的 `reviewing` 与 `testing` 留给整合验收。[`dsh-devflow-driver`](../../packages/devflow-driver/README.zh.md) 在 `devflow/stage-changed` 上认领阶段工作并经 subagent 执行器推进，并跳过拆分成子卡的卡片，使需求本身绝不成为某个子代理的 objective；[`dsh-command-devflow`](../../packages/devflow-command/README.zh.md) 是确定性的 `/devflow` 干预平面——看板与卡片视图、经同一执行器的移动（门禁照常裁决）、强制租约接管与 `archiveDone` 归档；[`dsh-devflow-web`](../../packages/devflow-web/README.zh.md) 是浏览器通道——harness webserver 上一条只读、按会话取值的 JSON 路由加一条变更流，由这条插件线自己拥有而不依赖任何框架转发面——[`dsh-client-ui-devflow`](../../packages/devflow-ui/README.zh.md) 在其上只读渲染看板：组合了侧边栏底座的部署里是一个侧栏页面，其余部署里是悬浮的会话头部控件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` — **which this repository does not carry**: the generator stayed in the harness when this line was extracted, so the block below is maintained by hand against the JSDoc in `packages/*/src` until the script is ported. Treat the source as the authority on any disagreement. The language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * stage. A blocked card cannot register artifacts, and the revision check
 * mirrors {@link transition}.
 * @param request - card, artifact path, expected revision, and actor.
 * @returns the outcome; domain rejections resolve with `ok: false`.
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
