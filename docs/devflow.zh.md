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

一张永远不会完成的卡是被**放弃**，而不是被停驻：除 `done` 外的任意位置都接受它，理由是必填的——因为那是这张卡唯一留下来的东西——而卡片离开看板进入归档，不再占着一个没人在做的列。放弃是终态，其后不允许任何 journal 条目——因此已放弃的卡片是唯一无法恢复的归档卡；它是一个人的决策，所以只在 `/devflow` 上，没有对应的模型侧工具。它连同理由一起，在档案里始终可读。决策由[放弃 Agent Note](../../.agents/notes/implemented/architecture/2026-08-31-devflow-reasoned-abandonment.zh.md) 拥有。

其中两个名字足够常被误读，值得直说。`testing` 指独立验证与验收，不是"到这一步才开始写测试"——本插件线自己的门禁就是每文件 100% 覆盖、测试与实现同处一个变更，所以一张卡带着没写的测试走到 `testing`，它在 `developing` 就已经失败了。`done` 的意思是这个变更在仓库里被证明是好的，不代表用户拿到了它。部署、发布与结果度量都在本模型之外，所以一列排满 `done` 的卡并不构成价值已交付的证据。

## Journal 条目

追加式 journal 是权威的卡片历史；卡片文件的 frontmatter 是可重建的投影。`decodeJournalEntry` 在持久化边界校验每个已解析的行，`foldJournal` 强制 revision 从 1 连续、`created` 必须且只能是首条、transition 必须从当前位置出发、blocked 精确恢复、`abandoned` 之后不得再有条目、只有 `done` 卡可以归档、以及归档卡之后只允许 `restored`。

归档和其他状态变更一样是 journal 事件：入档的卡片带一条 `archived`，被送回的卡片带一条 `restored`。两者都在人工的 `/devflow` 面上；`archive/<YYYY-MM>/` 下的目录移动发生在追加之后、属于清理，因此 `list` 依据折叠状态而非目录位置来判定谁是活跃的。恢复带回的是可见性，不是进度——一张恢复的 `done` 卡仍然是 done。决策由[归档生命周期 Agent Note](../../.agents/notes/implemented/architecture/2026-09-09-devflow-archive-lifecycle.md) 拥有。

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
/**
 * A delivered card left the active set for the root's archive. Unlike
 * `JournalAbandoned` this is not terminal: a `restored` entry may follow it,
 * which is what makes archiving reversible. Only a `done` card may carry one,
 * and while it is in force no other entry type may follow.
 */
interface JournalArchived {
  rev: number
  at: string
  type: 'archived'
  by: DevActor
  /**
   * Why the card was archived. Optional, unlike an abandonment's reason: an
   * archived card keeps its complete history, so nothing is lost by silence.
   */
  reason?: string
}
```

```ts type-equiv
/**
 * An archived card returned to the active set. It restores visibility only —
 * the card's stage is whatever its journal already said, so a restored `done`
 * card is still `done` and continuing its work is an ordinary rework
 * transition.
 */
interface JournalRestored {
  rev: number
  at: string
  type: 'restored'
  by: DevActor
  /** Why the card was brought back; recorded when present. */
  reason?: string
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
type DevflowJournalEntry =
  | JournalCreated
  | JournalTransition
  | JournalArtifact
  | JournalAbandoned
  | JournalArchived
  | JournalRestored
  | JournalClaimExpired
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
  /**
   * Set while the card sits in the root's archive. Off the active board like
   * `abandoned`, but not terminal: a restore clears it. A card archived
   * before archiving became a journal event carries no `archived` entry, so
   * this may be derived from where the card's directory sits.
   */
  archived?: true
  /**
   * The `YYYY-MM` bucket an archived card is filed under — the month its work
   * finished, which is what `CardQuery.month` narrows by. Present exactly
   * while `archived` is; it is not derivable from `updatedAt`, which by then
   * names the archiving itself.
   */
  archivedMonth?: string
  /** Timestamp of the card's first journal entry: when it was created. */
  createdAt: string
  /** Timestamp of the card's last journal entry: when it last moved. */
  updatedAt: string
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

两个卡片读取共用同一套谓词词汇；它们的区别在于分页，而不在于如何选中一张卡。`list` 返回活跃集的全部——它七个消费者里有六个依赖这一点，其中一个还是一道门——而 `query` 分页，并且是抵达档案的唯一途径，因为档案的规模无法承诺。

```ts type-equiv
/**
 * The predicate vocabulary both card reads narrow by. Declared once so
 * `CardFilter` and `CardQuery` can never drift into two dialects of the same
 * idea.
 */
interface CardPredicates {
  /** Only cards currently at this location. */
  stage?: CardLocation
  /** Only cards decomposing this one; an id with no children matches nothing. */
  parent?: DevflowCardId
  /** Only cards with no parent. Mutually exclusive with `parent`. */
  topLevel?: true
  /** Only cards created under this service class. */
  serviceClass?: ServiceClass
}
```

```ts type-equiv
/** Read filter accepted by {@link import('./index.ts').DevflowStore.list}. */
interface CardFilter extends CardPredicates {}
```

```ts type-equiv
/** Which card set a {@link CardQuery} reads. */
type CardSet = 'active' | 'archived' | 'all'
```

```ts type-equiv
/**
 * Narrowing and pagination accepted by
 * {@link import('./index.ts').DevflowStore.query}.
 */
interface CardQuery extends CardPredicates {
  /** Which set to read; omitted reads the active set. */
  set?: CardSet
  /**
   * Only archived cards filed under this `YYYY-MM` bucket. Meaningless
   * against the active set, so pairing it with `set: 'active'` is a usage
   * error rather than an empty result.
   */
  month?: string
  /** Page ceiling; omitted uses the implementation's configured default. */
  limit?: number
  /**
   * The previous page's `nextCursor`, passed back verbatim. Its encoding
   * belongs to the implementation — callers never parse or construct one, and
   * an unparsable cursor is a usage error rather than a silent restart from
   * the first page.
   */
  cursor?: string
}
```

```ts type-equiv
/**
 * One page of {@link import('./index.ts').DevflowStore.query}. Truncation is
 * always stated: a caller that cannot tell a full page from a complete result
 * will report the page as the whole set.
 */
interface CardPage {
  /** The cards of this page, in the set's reading order. */
  cards: DevCard[]
  /** Whether the limit cut the result short. */
  truncated: boolean
  /** Cursor for the next page; absent once the set is exhausted. */
  nextCursor?: string
}
```

## 服务行为

抽象的 [`DevflowStore`](../../packages/devflow/src/index.ts) Service Definition 规定 journal 权威的读面、显式创建/流转请求、迁移 waterfall 与独占 claim 租约。[`FilesystemDevflowStore`](../../packages/devflow-filesystem/src/index.ts) 是文件 Service Provider；[`dsh-tool-devflow`](../../packages/devflow-tool/README.zh.md) 是模型侧 Consumer，Harness agent 通过它创建、查看、登记产物并推进卡片。[`dsh-devflow-fs-guard`](../../packages/devflow-fs-guard/README.zh.md) 保证 store 是受保护卡片状态的唯一写路径。四项策略组合在迁移 waterfall 上：[`dsh-devflow-artifact-gate`](../../packages/devflow-artifact-gate/README.zh.md) 机械检查登记产物并发布主动需求预检；[`dsh-devflow-agent-gate`](../../packages/devflow-agent-gate/README.zh.md) 运行独立的 LLM 准入检查；[`dsh-devflow-gates`](../../packages/devflow-gates/README.zh.md) 运行命令与一次性审批；[`dsh-devflow-parent-gate`](../../packages/devflow-parent-gate/README.zh.md) 防止拆分需求早于其子卡完成。[`dsh-command-devflow`](../../packages/devflow-command/README.zh.md) 是确定性人工干预平面；[`dsh-devflow-web`](../../packages/devflow-web/README.zh.md) 与 [`dsh-client-ui-devflow`](../../packages/devflow-ui/README.zh.md) 提供只读浏览器通道与看板。系统刻意不设第二套后台执行器：执行与推进归 Harness agent，插件只拥有状态、工具、策略、命令与视图。

## 产物契约

想在流水线上落实产物纪律的部署,组合四个迁移策略,而 Harness agent 继续作为执行器——没有任何策略硬编码契约,整套东西就是配置。下面的样例是一个 profile 的 devflow 半边(harness 的 shell 执行器、subagent 运行时与 default-model 各行照常组合),流水线的每条边都带契约;[`tests/artifact-contract-composition.spec.ts`](../../tests/artifact-contract-composition.spec.ts) 用真实 Loader 启动同一组合形态,并驱动一张卡 draft→done 走完全程。

**加载序就是 waterfall 序。** `devflow/transition` 上的监听按注册顺序运行,所以四个策略的挂载顺序就是裁决顺序,样例的顺序是刻意的:**机械 → agent → 命令 → 审批/完成**,最便宜、最确定的在前。免费的结构检查先否决,checker 才不会在残缺的交付物上花模型预算;checker 先否决,命令门禁才不会在不可靠的工作上花一轮测试套件的墙钟时间;命令跑完才问人。真的配了审批的部署买到的是同一个顺序:人只在每个自动层都点头之后才被问到。[bundle](../../packages/devflow-bundle/README.md) 正是按这个顺序挂载它的策略行,组合测试也断言这个顺序成立——一个机械缺陷派发零个 checker、运行零条门禁命令。

**kind 在一个点定义并裁决。** `devflow-artifact-gate` 的 `kinds` 段是 kind 结构存在的唯一位置；它以只读服务 [`devflowArtifactStructures`](#ctxdevflowartifactspecs--artifactspecs-value-service) 发布，同时由 [`devflowArtifactContract`](#ctxdevflowartifactcontract--artifactcontract-value-service) 在移动前暴露完全相同的出边判定。其余各处只消费这套词汇而不复述其形状：agent gate 的 `inputs` 选择哪些登记喂给检查，模型工具渲染契约服务返回的动态预检——预检不会与真实门禁漂移。

```yaml
# 先 store，再按 waterfall 序的四个策略。Harness agent 通过模型工具编写产物并推进卡片。
- name: '@zhchxiao123/dsh-devflow-filesystem'

# 第 1 层——机械产物契约。`kinds` 是每个 kind 的唯一定义;`edges` 说明每条边
# 要求哪些 kind。流水线的六条边在这里都带契约。
- name: '@zhchxiao123/dsh-devflow-artifact-gate'
  config:
    kinds:
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

## 架构文档

寿命超过一张卡的知识住在第二条缝 [`ctx.devflowSpec`](../packages/devflow-spec/README.zh.md) 后面，而不在卡片 journal 里。文档存放于 `.devflow/spec/<id>.md`，frontmatter 加正文，每条实质论断都落在一个声明过的 **anchor** 上，store 在每次读取时求值：`symbol`（该名字必须仍被声明）、`content-hash`（该符号经解析器规范化后的体，其摘要必须不变）、`churn`（该文件不得在文档之后被提交）。裁决是三值的——`fresh`、`stale`、`unevaluable`——而第三种绝不折叠进第一种，因为**一个再也跑不动的校验不是一个通过了的校验**。

写入时每个 anchor 都必须求值为 `fresh`，因此此后的 `stale` 永远意味着代码动了，而不是这篇文档从一开始就是错的。未给出摘要的 `content-hash` anchor 取该符号当前的摘要：本线之外没有调用方算得出对规范化后的体取摘要这个值，强制要求它等于让最强的一类 anchor 在模型平面上不可达。

根目录位于 `.devflow/` 之内，而 [`dsh-devflow-fs-guard`](../packages/devflow-fs-guard/README.zh.md) 已拒绝文件工具写入该子树，因此 [`dsh-devflow-spec-tool`](../packages/devflow-spec-tool/README.zh.md) 是唯一写路径——被强制的，而非仅仅本意如此。spec 状态刻意留在 journal 之外：文档的权威是文件本身加 git，因此挂载或移除本缝**永远不会改变任何已提交卡片的回放结果**。相关决策由 [anchor 模型 Agent Note](../.agents/notes/implemented/architecture/2026-09-02-devflow-spec-anchor-model.zh.md) 拥有。

### 到达卡片

一张卡通过 `spec-refs` 产物说明自己的工作触及哪些文档——`## Scope` 小节列出 id 前缀。把它配成 `draft->designing` 的必备 kind，卡片不回答就出不了 draft。同一份登记随后成为每个单卡结果上可选 `specRefs` 索引的来源，形状与它旁边的 `artifactGates` 完全同构：id、标题、描述、路径、汇总新鲜度，**从不含正文**。正文经 `devflow_read_spec` 按需到达模型，而那次读取在文档非 fresh 时渲染明确的告警行——只返回散文的读取会丢掉这条缝存在的唯一理由。

从未声明的 scope 保持沉默——**卡片还没说清自己触及什么，是一张普通卡片的正常状态**——所声明的前缀查不到任何文档时同样省略索引，那个覆盖缺口交给 census 报告。但登记存在却读不出 scope——文件读不到、没有 `## Scope` 小节、或小节之下没有条目——会在单卡结果上放一行告警，说明索引没有被提供：这张卡承诺过声明，沉默会被读成「没有文档」。

### 修订与退役

`replaces` 是让集合能缩小的东西。指自身即原地修订；指其他篇即聚类合并并删除它们。增长上限按**净**变化计费，所以三合一从不因"太大"被拒——把合并按纯新增计费，恰恰会拒绝那个唯一缓解压力的动作。所有拒绝都在第一次写之前落定，因此被拒的合并让根目录逐字节不变；这刻意**不是**跨多文件的崩溃原子性：替换先写、删除后做，被打断的合并因此留下重复而不是缺口。

在出口处，`spec-delta` 产物让卡片对产出做分诊：`reference` 在这里成为文档，`obligation` 去往一套常驻并由校验脚本强制的规则集。把它配在**三条**终态边上——服务类别是加边而非替换，只写 `testing->done` 的契约恰好放过那些跳过评审的卡片。

### 读取集合的健康度

`/devflow spec` 在人类平面报告它：多少篇 fresh、哪些 stale 或 unevaluable **以及具体哪条 anchor 失效**、哪些期望的 scope 没有文档覆盖。它由 `list()` 加 `evaluate()` 推导而非新增 store 方法，也不是模型侧工具——全集普查正是卡片结果所遵循的"只下发索引"纪律的反面。覆盖率是配置而非发现，因为什么算一个包是工作区布局问题；什么都不配时报告会说"这个问题没有被问"，这与"没有缺口"不是一回事。

## 铁律

文档是**参考型**知识——该知道，相关时再读。另一种是**义务**，不遵守就是错，它采取相反的注入策略：[`dsh-devflow-iron-rules`](../packages/devflow-iron-rules/README.zh.md) 让规则正文常驻每一次请求而不是藏在索引后面，因为**模型从未打开的规则就是从未遵守的规则**。规则住在 `.devflow/iron-rules/<id>/`，一份 `RULE.md` 加可选的 `check.sh`；后者在碰过文件的 turn 将要结束时运行，失败以强制续轮返回，直到续轮上限把决定交还给人。

记录要求陈述式分诊——`script` 或 `judgement`，其中 `script` 必须同时给出校验脚本与它监视的路径——因为跳过"脚本能不能判定这件事"正是规则集退化成纯散文的路径。同一条写入路径以 `ctx.devflowIronRules` 发布，因此 `spec-delta` 的 obligation 是一次转发调用，而不是谁手打的一段回执。没有那条缝的部署没有安放义务的地方，必须明说。

## Model guidance

这套分类学还有第三种知识：**过程判断**——工作何时该上看板、一张卡该取哪个 service class、需求怎么拆、什么样的产物过得了闸门、被 veto 后如何返工。违背它不是破坏规则，而是把工作流开得很差，因此它采用目录策略而非常驻：[`dsh-devflow-guidance`](../packages/devflow-guidance/README.md) 把它作为 bundled `devflow-workflow` skill 发布，常驻的只有一行目录条目，正文按需加载，并可被同层更低 rank 的同名 provider 覆盖。正文刻意不陈述任何部署的产物契约——工具结果里的 artifact-gate 预检才是那件事的权威，且恰好在适用的时刻送达。第二个 bundled skill `devflow-spec-authoring` 承载架构文档的撰写判断——什么值得成文档、什么该是铁律、anchor 怎么选、id 怎么划 scope、经 `replaces` 修订、读到 stale 后如何应对——且只在组合挂载 `ctx.devflowSpec` 时注册，因此目录永远不会宣传一个教不存在能力的 skill。

同一个包还回答了任何工具描述都答不了的问题——*这个工作区有没有一块值得先读的看板*——靠的是 `devflow-board` 运行时上下文：各阶段计数、被 claim 的卡，加一句指向 `devflow_create` 与 skill 的指引，上限 1024 字节，因为 awareness 不是看板镜像，真正的看板只隔一次 `devflow_list`。pre-step 监听器每步重读看板（没有 `.devflow/` 的工作区只是一次失败的 readdir，因此不贡献任何内容），harness 对渲染结果做 diff，看板不变就绝不重发。两层都不承载义务：单次调用协议留在工具描述里，enforcement 留在闸门上，所以从不加载 skill 或抑制 runtime context 的部署失去的是引导，从不是保证。

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
 * List the cards in the active set of one root — all of them, so a caller
 * that must reason over the whole board (a completion policy, a board
 * snapshot, a parent's progress) can trust the count.
 *
 * That completeness is why this read takes no page: it can be promised for
 * the active set and not for the archive, which grows without bound. Reach
 * archived cards through {@link query} instead.
 * @param filter - optional narrowing; omitted lists every card.
 * @param root - devflow root to list; omitted uses the implementation's default root.
 * @returns cards ordered by id.
 * @throws {Error} when the filter states both `parent` and `topLevel`.
 */
abstract list(filter?: CardFilter, root?: string): Promise<DevCard[]>

/**
 * Read one page of a card set: the same predicates {@link list} narrows by,
 * plus the set to read and where to resume.
 *
 * Implementations stop reading at the limit rather than collecting the set
 * and slicing it. The cost a caller should know: narrowing does not make the
 * read cheaper, because each card must be loaded before its predicates can
 * be judged — a page of five matches out of a thousand cards still loads a
 * thousand cards. What the limit saves is everything after the page fills.
 * @param query - narrowing, set selection, and pagination; omitted reads the
 *   first page of the active set.
 * @param root - devflow root to read; omitted uses the implementation's default root.
 * @returns the page, stating whether the limit cut it short.
 * @throws {Error} for contradictory predicates, a malformed month, a
 *   non-positive limit, or a cursor this store did not issue.
 */
abstract query(query?: CardQuery, root?: string): Promise<CardPage>

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
 * File one delivered card in its root's archive: the `archived` journal
 * append is the commit point, and the directory move that follows is
 * cleanup. Archived cards leave {@link list} but keep their complete
 * journal, stay readable through {@link read}, and can come back through
 * {@link restore}.
 *
 * A requirement archives with its finished slices: they share its bucket, so
 * a decomposed piece of work stays one family on disk. A slice cannot go
 * first — hidden while its requirement still runs, it would vanish from that
 * requirement's progress and from the completion policy's view.
 * @param request - card, expected revision, actor, and an optional reason.
 * @returns the outcome; domain rejections resolve with `ok: false`. A cascade
 *   that partially committed is not rolled back: the journal is append-only,
 *   and retrying skips what already filed as `already-archived`.
 */
abstract archive(request: ArchiveRequest): Promise<ArchiveResult>

/**
 * Return an archived card to the active set, at the stage its journal
 * already recorded. Restoring changes visibility, not progress: a restored
 * `done` card is still done, and resuming work on it is an ordinary rework
 * transition. An abandoned card is refused — that decision is terminal, and
 * reversing it means a new card.
 * @param request - card, expected revision, actor, and an optional reason.
 * @returns the outcome; domain rejections resolve with `ok: false`.
 */
abstract restore(request: RestoreRequest): Promise<RestoreResult>

/**
 * Archive every `done` card of one root that is eligible, through the same
 * commit path as {@link archive}.
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

### `ctx.devflowArtifactStructures` — `ArtifactStructures` (value service)

Read-only kind-spec table published by `dsh-devflow-artifact-gate`, registered for the plugin's fiber lifetime and gone when it disposes. Optional service: read it with `ctx.get('devflowArtifactStructures')`, never the property proxy — a deployment without the gate simply has no specs to template against.

```ts cordis-catalog
/**
 * The gate's configured kind specs, published read-only so a producer can
 * shape a deliverable to the same spec the gate will check. Optional
 * service: read it with `ctx.get('devflowArtifactStructures')`.
 */
devflowArtifactStructures: ArtifactStructures

/**
 * Value of the `devflowArtifactStructures` service: the configured specs, deep
 * frozen and normalized (empty lists dropped).
 */
type ArtifactStructures = { readonly [kind: string]: ArtifactKindStructure }

/**
 * Structural requirements of one artifact kind. Both lists are optional and an
 * empty list equals omission; a kind declared with neither is required only to
 * be registered. The lists stay mutable in type for the config validator's
 * sake; the published service value is deep frozen regardless.
 */
interface ArtifactKindStructure {
  /**
   * Frontmatter fields the artifact must carry, each present with a value —
   * a key mapped to nothing counts as missing.
   */
  frontmatter?: string[]
  /** Second-level section titles (without the `## ` prefix) the artifact must contain. */
  sections?: string[]
}

interface PublishedArtifactKindStructure {
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
  readonly spec: PublishedArtifactKindStructure
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

<a id="devflowcard-archived--emit"></a>

#### `devflow/card-archived` — emit

一张卡离开活跃集合、进入档案。每张归档的卡各派发一次，所以一次跨需求子卡的级联会为每张各派发一次。刻意不并进 `devflow/stage-changed`：归档并不移动卡片，硬并进去会让每个监听者都得再判别一次到底发生了哪一种。

```ts cordis-catalog
/**
 * A card left the active set for the archive.
 * @mode emit
 * @param card - the card as of the committed `archived` entry.
 */
'devflow/card-archived'(card: DevCard): void
```

Source: [`packages/devflow/src/types.ts`](../../packages/devflow/src/types.ts)

<a id="devflowcard-restored--emit"></a>

#### `devflow/card-restored` — emit

一张归档卡按其原有阶段回到活跃集合。

```ts cordis-catalog
/**
 * An archived card returned to the active set at the stage it already had.
 * @mode emit
 * @param card - the card as of the committed `restored` entry.
 */
'devflow/card-restored'(card: DevCard): void
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
