# @zhchxiao123/dsh-devflow-spec-tool

[English](README.md) | 中文

**[spec 缝](../devflow-spec/README.zh.md)的模型侧半边**：`devflow_write_spec` 提交一篇架构文档。它是 `ctx.devflowSpec` 之上的薄 Consumer——id 合法性、结构契约与 anchor 求值都在缝后面，因此这里的拒绝携带缝自己的稳定 code。

## 契约

`devflow_write_spec({ id, title, description?, body, anchors, replaces? })` 提交一篇文档，返回它的 id、路径、anchor 数量与被它替换掉的 id。

- `id` 是以斜杠连接的 scope 路径（`@scope/package/backend/error-handling`）；每段必须匹配 `^[@a-z0-9][a-z0-9._@-]*$`，且**拒绝发生在 id 层面，早于任何路径拼接**。
- `body` 必须带 `## Source of truth` 小节，并以 `[[id]]` 引用每一个声明的 anchor。
- `anchors` 至少一条。`symbol` 与 `content-hash` 还需 `symbol`。`content-hash` 通常**省略** `hash`：本线之外没有调用方算得出那个摘要——它取自解析器规范化后的符号体——因此由 store 记录该符号当前的摘要。找不到的符号会让它无法解析，写入被拒绝。
- `replaces` 列出被这篇取代的已有文档；它们会被删除（历史留在 git 里）。列**文档自己的 id 即原地修订**；列**多个 id 即合并一簇**——当两篇文档已经在说同一件事时，该做的是合并而不是添第三篇。这是文档集收缩的唯一途径：写入已存在的 id 而不在此列出，以 `exists` 拒绝；列出的 id 不存在，以 `unknown-replaced` 拒绝。store 对单次写入的**净**增长设预算——新文件字节数减去所有被替换者——超出上限以 `budget-exceeded` 拒绝，因此合并永远不会因为体量大而被拒。

写入时每个声明的 anchor 都必须求值为 `fresh`——**一篇文档不得一出生就是过期的**。拒绝以工具错误浮出，前缀是缝的 code，即封闭的 `SpecWriteRejectionCode` 集合：`invalid-id`、`missing-source-of-truth`、`no-anchors`、`duplicate-anchor-id`、`uncited-anchor`、`unknown-anchor`、`unknown-replaced`、`exists`、`anchor-unresolvable`、`budget-exceeded`。

本工具要求归属的 agent 会话；没有会话的调用者在产生任何副作用前被拒绝。

**这是文档抵达磁盘的唯一途径**，而且是被强制的而非仅仅"本意如此"：spec 根位于 `.devflow/` 之下，而 [`dsh-devflow-fs-guard`](../devflow-fs-guard/README.zh.md) 拒绝文件工具写入该子树。

`devflow_read_spec({ id })` 把一篇文档读回来，其 anchor 对当前代码求值：正文、摘要字段，以及每个 anchor 一条裁决。**文档不是 `fresh` 时，渲染文本会带一行告警**并点名失效的 anchor——一个只返回正文的读取工具会把本缝赖以存在的那个信号丢在传输层，而读者无从知道它丢了。正文照常返回：一篇过期文档配上告警仍然值得读。读取没有副作用，但仍要求归属的 agent 会话：两个文件系统根都从会话的工作目录解析，从不取进程 cwd——没有会话的调用者根本没有可读的 spec 根。

一份让卡片声明自己触及哪些文档的样例组合——该 kind 的 `References` 条目**不**受结构校验，只校验小节存在，因此条目质量若要强制，属于准入门禁：

```yaml
- name: '@zhchxiao123/dsh-devflow-artifact-gate'
  config:
    kinds:
      spec-refs:
        sections: [Scope, References]
    edges:
      'draft->designing': [prd, spec-refs]
```

### 收口：`spec-delta`

出口处的对应物。`spec-refs` 让卡片说清将要触及什么；`spec-delta` 让它说清工作产出了什么，并对每一条产出说明**该由哪一层强制**：

```yaml
- name: '@zhchxiao123/dsh-devflow-artifact-gate'
  config:
    kinds:
      spec-delta:
        sections: [Changes, Classification, Verdict]
        nonEmptySections: [Classification, Verdict]
    edges:
      'testing->done':    [spec-delta]
      'reviewing->done':  [spec-delta]
      'developing->done': [spec-delta]
```

**三条终态边全配，不是只配 `testing->done`。** 服务类别是**加边**而非替换：`express` 从 `reviewing` 到达 `done`，`emergency` 从 `developing` 到达——只写标准路线的契约，恰好放过了那些跳过评审的卡片，而且是静默放过，没有任何地方会说这张卡从未交过 `spec-delta`。`emergency` 该不该豁免是部署方的决定，但它必须是**一个决定**。

`nonEmptySections` 是让这份必填分诊不止于一个标题的东西。底下什么都没有的 `## Classification` 能通过存在性检查，却什么也没回答。

**Classification 把每条产出分进两个归宿之一。** `reference`（该知道，但不是每次都相关）经 `devflow_write_spec` 成为文档，以索引行的形式到达后续卡片。`obligation`（不遵守就是错）属于一套常驻并由校验脚本强制的规则集；挂了 [`dsh-devflow-iron-rules`](../devflow-iron-rules/README.zh.md) 的部署经 `ctx.get('devflowIronRules')` 的 `record(agent, input)` 转发，回执就是那次调用的返回值，而不是谁手打的一段散文。**没挂那条缝的部署没有安放 obligation 的地方，必须明说**——模板允许一条显式的「本部署无 obligation 去处」裁决，因为另一种结果是 obligation 悄悄变成 reference。

门禁能机械查的到此为止：小节存在、其中两节非空。分诊是否诚实、`no-change` 的理由是否**针对这张卡**、`obligation` 行有没有带上它的规则 id——这些是语义判断，归准入门禁：

```yaml
- name: '@zhchxiao123/dsh-devflow-agent-gate'
  config:
    edges:
      'testing->done':
        prompt: |
          读这张卡的 spec-delta 产物，判三件事。
          1. 每条产出都标了 `obligation` 或 `reference`，没有骑墙的行。
          2. `no-change` 裁决给出的理由针对**这张卡**。「本卡无 spec 变更」不算；
             「改动局限在测试夹具，没有任何文档描述它」算。
          3. 每条 `obligation` 行写明了它被记录成的规则 id，且**不**同时写 spec 文档 id
             ——一条产出同时落在两处，就是两份将来必然打架的事实来源。
          否决时引用不合格的那一行。
```

## 呈现意图

两个呈现器都是参数的纯函数：写入呈现 `edit` 类的 `generic` 卡，`rawInput` 为文档标题；读取呈现 `read` 类的，`rawInput` 为 id。

## Model Experience

### Tool schema

#### What the model sees

两个工具。写入工具的描述明说 anchor 纪律——anchor 正是让一篇文档能自我失效的东西，读者会被告知文档已过期而不是照着它做——因为把 anchor 当成登记手续的模型，会写出通过结构契约却什么都保护不了的文档。它还说明每次写入落地的都是一整篇新文档、修订与合并走 `replaces`，于是被 `exists` 拒绝的模型会伸手去用那个字段，而不是造一个近似重复的 id。读取工具的描述说清裁决的含义：过期的文档必须先对照代码核实再遵循。

#### Token effect

插件激活期间固定的 schema 成本。写入结果是四个短字段；读取结果携带整篇正文，成本随文档大小变化。

#### KV Cache effect

插件作用域不变时前缀稳定；激活或卸载可能使工具 schema 段及其后的复用失效。

## 撰写 skill

本包附带 [`skills/dsh-write-spec`](skills/dsh-write-spec/SKILL.md)：一篇文档该论断什么、哪一类 anchor 才抓得住你真正担心的那种变化、以及什么情况下一条论断根本不配拥有一篇文档。给一个包写第一篇文档之前先读它——结构契约分辨不出「锚得好的文档」和「随手锚了容易锚的东西的文档」。

## Known Limitations and Deferred Work

- **没有索引工具。** `devflow_read_spec` 需要一个 id。一个 scope 下有哪些文档，靠的是 [`dsh-devflow-tool`](../devflow-tool/README.zh.md) 在单卡结果上携带的 `specRefs` 索引，它以卡片自身的 `spec-refs` 登记为准；不存在脱离卡片、按 scope 通查的列举工具。

- **没有局部编辑。** 存储以整篇文档为单位：经 `replaces` 修订意味着重新给出完整正文，而不是修补其中一部分。
