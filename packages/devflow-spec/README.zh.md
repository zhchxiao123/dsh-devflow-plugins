# @zhchxiao123/dsh-devflow-spec

[English](README.md) | 中文

**`ctx.devflowSpec` 能力缝的 Service Definition**：架构文档，其中每条论断都由可求值的 anchor 系在它所描述的代码上。本包拥有 anchor 词汇与每次写入必须通过的结构谓词。存储与 anchor 求值属于 `dsh-devflow-spec-filesystem` 这样的 Provider；模型侧写入工具是 `dsh-devflow-spec-tool`。

这里的文档不是"顺便引用了代码的散文"。每条论断都落在一个声明过的 anchor 上，而一个不再解析得通的 anchor 会让文档自己报告已过期。这正是本缝存在的理由：**过期的架构文档比没有更糟**，因为 agent 会照着它自信地写代码。

## 服务

`DevflowSpecStore` 是注册在 `ctx.devflowSpec` 上的抽象 Cordis `Service`（每个 context 只允许一个实现；重复注册抛错）。它是**可选**服务——消费者用 `ctx.get('devflowSpec')` 读取，绝不用属性代理，因此没有组合本缝的部署只是没有文档而已。

| 方法 | 行为 |
|---|---|
| `list(scope?, root?)` | 按 id 排序的索引值；`scope` 以 id 前缀收窄到一个包或一个 face。每条摘要携带汇总后的新鲜度。 |
| `read(id, root?)` | 一篇文档、它声明的 anchor 及其裁决。读者必须能得知自己刚读到的东西已经过期。 |
| `evaluate(id, root?)` | 只要裁决，按声明顺序每个 anchor 一条。 |
| `resolveWrite(request)` | 实现方补全默认值：省略时的 spec root，以及记为 `updatedAt` 的提交时间戳。 |
| `write(spec)` | 提交一篇文档：id 校验 → 结构校验 → anchor 求值 → 文件写入。领域拒绝解析为 `ok: false`；仅基础设施故障才 reject。 |

写入时每个声明的 anchor 都必须求值为 `fresh`——**一篇文档不得一出生就是过期的**。

## Anchor

三类，以 `kind` 判别：

| 类型 | 把论断系在 | 何时过期 |
|---|---|---|
| `symbol` | 某个符号的继续存在 | 符号被改名或删除 |
| `content-hash` | 某个符号的实现，对其规范化后的体取 hash | 改了一行；重新格式化不会 |
| `churn` | 整个文件的最后一次提交 | 该文件的提交时间晚于文档的 `updatedAt` |

`AnchorVerdict` 是**三值**的——`fresh`、`stale`、`unevaluable`——而第三种如实呈现，绝不折叠进第一种。**一个再也跑不动的校验不是一个通过了的校验**；把它折叠成通过，正是"永远绿灯"的成因。`worstFreshness` 汇总时 `stale` 压过 `unevaluable`，因为一个确定的失败盖得住任意多个未知。

## 结构契约

`write` 以稳定 code 拒绝，而不是收下一篇此后无从校验的文档：

| Code | 成因 |
|---|---|
| `invalid-id` | 某个 id 段不匹配 `^[@a-z0-9][a-z0-9._@-]*$`；拒绝发生在 id 层面，早于任何路径拼接 |
| `missing-source-of-truth` | 没有 `## Source of truth` 小节 |
| `no-anchors` | 什么都没系住的文档；它会永远报告 `fresh` |
| `duplicate-anchor-id` | 两个 anchor 用了同一个 id，引用将无法确定指向 |
| `uncited-anchor` | 声明了却从未被正文以 `[[<id>]]` 引用的 anchor |
| `unknown-anchor` | 正文引用了没有任何声明定义的 anchor |
| `anchor-unresolvable` | 写入时求值不为 `fresh` 的 anchor |
| `exists` | id 已被占用 |

引用关系**双向校验**：只查一半，就会让文档要么攒下无人依赖的 anchor，要么让论断落在从未声明过的 anchor 上。

本契约刻意**不**校验的是"每条实质论断都挂了 anchor"。那是自然语言判断，因此它属于流转边上的 LLM 准入门禁，不属于机械结构校验。把查不了的规则塞进机械层，只会产出一个假装严格的校验。

## Model Experience

间接经由 `dsh-devflow-spec-tool` 的模型侧工具；服务接口本身不注册任何提示词或 schema。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **无 revision 回放。** 文档的历史是文件本身加 git，不是折叠出来的事件流。spec 状态刻意留在卡片 journal 之外，因此引入或移除本缝**永远不会改变任何已提交卡片的回放结果**。
- **`symbol` 与 `content-hash` 仅支持 TypeScript。** 没有解析器读得懂的文件只能挂 `churn`。
- **读取侧不强制新鲜度。** 本缝报告新鲜度；这里没有任何东西会拒绝提供一篇过期文档。过期读取是否阻断工作，是部署方的门禁配置决定的。
