# @zhchxiao123/dsh-devflow-spec-tool

[English](README.md) | 中文

**[spec 缝](../devflow-spec/README.zh.md)的模型侧半边**：`devflow_write_spec` 提交一篇架构文档。它是 `ctx.devflowSpec` 之上的薄 Consumer——id 合法性、结构契约与 anchor 求值都在缝后面，因此这里的拒绝携带缝自己的稳定 code。

## 契约

`devflow_write_spec({ id, title, description?, body, anchors })` 创建一篇文档，返回它的 id、路径与 anchor 数量。

- `id` 是以斜杠连接的 scope 路径（`@scope/package/backend/error-handling`）；每段必须匹配 `^[@a-z0-9][a-z0-9._@-]*$`，且**拒绝发生在 id 层面，早于任何路径拼接**。
- `body` 必须带 `## Source of truth` 小节，并以 `[[id]]` 引用每一个声明的 anchor。
- `anchors` 至少一条。`symbol` 与 `content-hash` 还需 `symbol`。`content-hash` 通常**省略** `hash`：本线之外没有调用方算得出那个摘要——它取自解析器规范化后的符号体——因此由 store 记录该符号当前的摘要。找不到的符号会让它无法解析，写入被拒绝。

写入时每个声明的 anchor 都必须求值为 `fresh`——**一篇文档不得一出生就是过期的**。拒绝以工具错误浮出，前缀是缝的 code：`invalid-id`、`missing-source-of-truth`、`no-anchors`、`duplicate-anchor-id`、`uncited-anchor`、`unknown-anchor`、`anchor-unresolvable`、`exists`。

本工具要求归属的 agent 会话；没有会话的调用者在产生任何副作用前被拒绝。

**这是文档抵达磁盘的唯一途径**，而且是被强制的而非仅仅"本意如此"：spec 根位于 `.devflow/` 之下，而 [`dsh-devflow-fs-guard`](../devflow-fs-guard/README.zh.md) 拒绝文件工具写入该子树。

## 呈现意图

`edit` 类的 `generic` 卡，`rawInput` 为文档标题。呈现器是参数的纯函数。

## Model Experience

### Tool schema

#### What the model sees

一个工具。它的描述明说 anchor 纪律——anchor 正是让一篇文档能自我失效的东西，读者会被告知文档已过期而不是照着它做——因为把 anchor 当成登记手续的模型，会写出通过结构契约却什么都保护不了的文档。

#### Token effect

插件激活期间固定的 schema 成本；结果是三个短字段。

#### KV Cache effect

插件作用域不变时前缀稳定；激活或卸载可能使工具 schema 段及其后的复用失效。

## 撰写 skill

本包附带 [`skills/dsh-write-spec`](skills/dsh-write-spec/SKILL.md)：一篇文档该论断什么、哪一类 anchor 才抓得住你真正担心的那种变化、以及什么情况下一条论断根本不配拥有一篇文档。给一个包写第一篇文档之前先读它——结构契约分辨不出「锚得好的文档」和「随手锚了容易锚的东西的文档」。

## Known Limitations and Deferred Work

- **只做创建。** 修订或替换已有文档不属于本操作；`exists` 会拒绝。带净变化预算的修订属于后续变更。
- **没有读取工具。** 通过模型平面读回文档尚不属于本包；缝的读面已存在但还没有模型侧消费者。
- **给出的 `hash` 被信任为确实取自被锚定的符号。** 省略它才是常规路径，由 store 算出正确的摘要；调用方若给一个取自别处的值，得到的就是一篇构造上永远新鲜、实则毫无意义的文档。
