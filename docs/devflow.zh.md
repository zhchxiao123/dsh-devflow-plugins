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

```ts type-equiv
/**
 * The closed set of service classes a card is created under, each selecting
 * which edges of the pipeline that card may take. Every class is a superset of
 * `standard`, so a class only ever adds a shortcut.
 */
type ServiceClass = 'standard' | 'express' | 'emergency'
```

卡片在创建时归入三个封闭的**服务类别**之一，创建后不可更改，它决定这张卡可以走哪些边。`standard` 是缺省值，走满整条流水线。`express` 可以从 `draft` 直达 `developing`、从 `reviewing` 直达 `done`，跳过设计、就绪与独立验证，但保留同行评审。`emergency` 可以从 `draft` 直达 `developing`、从 `developing` 直达 `done`，连评审一起放弃；它的后续复盘是一张普通的卡，而不是状态机里的一条义务。每个类别都是 `standard` 的超集——类别只增不减——而一个类别跳过的阶段并不是被绕过的门禁，因为卡片根本不经过那条边。这些捷径都是普通的 `from->to` 键，部署方可以像给任何其他边一样给它们配门禁。词表封闭的理由与阶段列表相同；决策由[服务类别 Agent Note](../../.agents/notes/implemented/architecture/2026-08-31-devflow-service-class.zh.md) 拥有。

移动沿流水线顺序进行，另加把卡送回缺陷归属阶段的返工边：`reviewing` 与 `testing` 都可回到 `developing` 和 `designing`，`developing` 可回到 `designing`——实现一份设计正是发现它错了的最常见方式，而在此之前唯一的退路是让卡片经过一次从未发生的评审。每条返工边都要求记录 `reason`。任何非终态位置都可进入 `blocked`，而 blocked 只能恢复到它打断的那个阶段；`done` 不出边。

一张永远不会完成的卡是被**放弃**，而不是被停驻：除 `done` 外的任意位置都接受它，理由是必填的——因为那是这张卡唯一留下来的东西——而卡片离开看板进入归档，不再占着一个没人在做的列。放弃是终态，其后不允许任何 journal 条目；它是一个人的决策，所以只在 `/devflow` 上，没有对应的模型侧工具。决策由[放弃 Agent Note](../../.agents/notes/implemented/architecture/2026-08-31-devflow-reasoned-abandonment.zh.md) 拥有。

其中两个名字足够常被误读，值得直说。`testing` 指独立验证与验收，不是"到这一步才开始写测试"——本插件线自己的门禁就是每文件 100% 覆盖、测试与实现同处一个变更，所以一张卡带着没写的测试走到 `testing`，它在 `developing` 就已经失败了。`done` 的意思是这个变更在仓库里被证明是好的，不代表用户拿到了它。部署、发布与结果度量都在本模型之外，所以一列排满 `done` 的卡并不构成价值已交付的证据。

## Journal 条目

追加式 journal 是权威的卡片历史；卡片文件的 frontmatter 是可重建的投影。`decodeJournalEntry` 在持久化边界校验每个已解析的行，`foldJournal` 强制 revision 从 1 连续、`created` 必须且只能是首条、transition 必须从当前位置出发、blocked 精确恢复、`abandoned` 之后不得再有条目。

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
  /**
   * The card's service class, fixed here at creation and never changed.
   * Omitted is `standard`, so a journal written before classes existed reads
   * as one and a `standard` card's first entry keeps its original bytes.
   */
  serviceClass?: ServiceClass
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
/**
 * The decision to stop: this card will never be finished. Terminal — no entry
 * may follow it — and the card leaves the active board rather than occupying
 * a stage nobody is working in.
 */
interface JournalAbandoned {
  rev: number
  at: string
  type: 'abandoned'
  by: DevActor
  /**
   * Why the work stopped. Required, unlike a transition's reason: a transition
   * leaves the card visible and explicable from where it sits, while this
   * removes it from the board, so the reason is all that is left of it.
   */
  reason: string
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
type DevflowJournalEntry = JournalCreated | JournalTransition | JournalArtifact | JournalAbandoned | JournalClaimExpired
```

## 读值

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
  /**
   * The card's service class, selecting which pipeline edges it may take.
   * Always present: a card whose journal states none is `standard`.
   */
  serviceClass: ServiceClass
  /**
   * Set once the card was abandoned: the work stopped and will not resume.
   * Such a card is off the active board, so `list` never reports one.
   */
  abandoned?: true
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

## 服务行为

抽象的 [`DevflowStore`](../../packages/devflow/src/index.ts) Service Definition 规定 journal 权威的读面、显式创建/流转请求、迁移 waterfall 与独占 claim 租约。[`FilesystemDevflowStore`](../../packages/devflow-filesystem/src/index.ts) 是文件 Service Provider；[`dsh-tool-devflow`](../../packages/devflow-tool/README.zh.md) 是模型侧 Consumer，Harness agent 通过它创建、查看、登记产物并推进卡片。[`dsh-devflow-fs-guard`](../../packages/devflow-fs-guard/README.zh.md) 保证 store 是受保护卡片状态的唯一写路径。四项策略组合在迁移 waterfall 上：[`dsh-devflow-artifact-gate`](../../packages/devflow-artifact-gate/README.zh.md) 机械检查登记产物并发布主动需求预检；[`dsh-devflow-agent-gate`](../../packages/devflow-agent-gate/README.zh.md) 运行独立的 LLM 准入检查；[`dsh-devflow-gates`](../../packages/devflow-gates/README.zh.md) 运行命令与一次性审批；[`dsh-devflow-parent-gate`](../../packages/devflow-parent-gate/README.zh.md) 防止拆分需求早于其子卡完成。[`dsh-command-devflow`](../../packages/devflow-command/README.zh.md) 是确定性人工干预平面；[`dsh-devflow-web`](../../packages/devflow-web/README.zh.md) 与 [`dsh-client-ui-devflow`](../../packages/devflow-ui/README.zh.md) 提供只读浏览器通道与看板。系统刻意不设第二套后台执行器：执行与推进归 Harness agent，插件只拥有状态、工具、策略、命令与视图。

## 产物契约

想在流水线上落实产物纪律的部署,组合四个迁移策略,而 Harness agent 继续作为执行器——没有任何策略硬编码契约,整套东西就是配置。下面的样例是一个 profile 的 devflow 半边(harness 的 shell 执行器、subagent 运行时与 default-model 各行照常组合),流水线的每条边都带契约;[`tests/artifact-contract-composition.spec.ts`](../../tests/artifact-contract-composition.spec.ts) 用真实 Loader 启动同一组合形态,并驱动一张卡 draft→done 走完全程。

**加载序就是 waterfall 序。** `devflow/transition` 上的监听按注册顺序运行,所以四个策略的挂载顺序就是裁决顺序,样例的顺序是刻意的:**机械 → agent → 命令 → 审批/完成**,最便宜、最确定的在前。免费的结构检查先否决,checker 才不会在残缺的交付物上花模型预算;checker 先否决,命令门禁才不会在不可靠的工作上花一轮测试套件的墙钟时间;命令跑完才问人。真的配了审批的部署买到的是同一个顺序:人只在每个自动层都点头之后才被问到。[bundle](../../packages/devflow-bundle/README.md) 正是按这个顺序挂载它的策略行,组合测试也断言这个顺序成立——一个机械缺陷派发零个 checker、运行零条门禁命令。

**kind 在一个点定义并裁决。** `devflow-artifact-gate` 的 `specs` 段是 kind 结构存在的唯一位置；它以只读服务 [`devflowArtifactSpecs`](#ctxdevflowartifactspecs--artifactspecs-value-service) 发布，同时由 [`devflowArtifactContract`](#ctxdevflowartifactcontract--artifactcontract-value-service) 在移动前暴露完全相同的出边判定。其余各处只消费这套词汇而不复述其形状：agent gate 的 `inputs` 选择哪些登记喂给检查，模型工具渲染契约服务返回的动态预检——预检不会与真实门禁漂移。

```yaml
# 先 store，再按 waterfall 序的四个策略。Harness agent 通过模型工具编写产物并推进卡片。
- name: '@zhchxiao123/dsh-devflow-filesystem'

# 第 1 层——机械产物契约。`specs` 是每个 kind 的唯一定义;`edges` 说明每条边
# 要求哪些 kind。流水线的六条边在这里都带契约。
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
      'ready->developing': [prd, design]   # 开工时仍须在盘上
      'developing->reviewing': [implement]
      'reviewing->testing': [review]
      'testing->done': [test-report]

# 第 2 层——agent 准入。inputs 只提 kind 名;checker 读它们的最新登记。
# 要求"必须登记过"仍是第 1 层的职责。
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

# 第 3 层——命令门禁。`approvals` 刻意留空:边上的人工审批会拦下每一张经过
# 它的卡,而它想抓的缺陷本就是下面那条门禁命令、以及流水线对每张卡都强制的
# `reviewing` 阶段的职责。只在爆炸半径确实值得把所有卡都拦下来的边上加审批,
# 并且要把它的代价读成每张卡的延迟,而不是一次性的搭建成本。
- name: '@zhchxiao123/dsh-devflow-gates'
  config:
    edges:
      'developing->reviewing': ['pnpm run verify']
    policies:
      'developing->reviewing':
        timeoutMs: 600000

# 第 4 层——完成:拆分的需求只有在每张子卡完成后才能到 done。无配置:
# 规则就是关系本身。
- name: '@zhchxiao123/dsh-devflow-parent-gate'

# Harness agent 是生产者与执行者。它读取每次工具结果中的 artifactGates
# 预检,通过 devflow_attach_artifact 登记必需 kind,并显式推进卡片。
```

返工闭环不需要第二个编排器:否决把卡留在原地并带上理由(agent 否决的完整报告落在 `reportDir` 下),Harness agent 登记同一 kind 的修正版本,重试就对照这份最新登记重新检查——输入 revision 变了会错过裁决缓存,agent gate 因此重新派发;而什么都没变的重试复用缓存裁决,不再花第二个 checker。

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

interface PublishedArtifactKindSpec {
  readonly frontmatter?: readonly string[]
  readonly sections?: readonly string[]
}
```

Source: [`packages/devflow-artifact-gate/src/types.ts`](../../packages/devflow-artifact-gate/src/types.ts)

<a id="ctxdevflowartifactcontract--artifactcontract-value-service"></a>

### `ctx.devflowArtifactContract` — `ArtifactContract`（值服务）

artifact gate fiber 生命周期内发布的可选动态预检。`inspectOutgoing(card)` 返回已配置且合法的出边，以及每个必备 kind 的不可变规格、最新登记、`missing | malformed | satisfied` 状态与全部缺陷。transition listener 使用同一个内部 inspection，因此展示缺陷与真实门禁完全一致。

```ts cordis-catalog
interface ArtifactContract {
  inspectOutgoing(card: DevCard): Promise<readonly ArtifactTransitionInspection[]>
}

interface ArtifactTransitionInspection {
  readonly from: CardLocation
  readonly to: CardLocation
  readonly requirements: readonly ArtifactRequirementInspection[]
}

interface ArtifactRequirementInspection {
  readonly kind: string
  readonly status: 'missing' | 'malformed' | 'satisfied'
  readonly spec: PublishedArtifactKindSpec
  readonly artifact?: Readonly<ArtifactRecord>
  readonly defects: readonly string[]
}
```

来源：[`packages/devflow-artifact-gate/src/types.ts`](../../packages/devflow-artifact-gate/src/types.ts)

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
