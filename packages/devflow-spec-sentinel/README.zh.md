# @zhchxiao123/dsh-devflow-spec-sentinel

[English](README.md) | 中文

**devflow spec 文档的 turn 末哨兵与 pre-step 索引。** 本插件监视一个 turn 的一方 `write`/`edit` 调用落在哪些文件上；当将要结束的 turn 让某篇挂锚的架构文档变为过期时，它以 steer 强制一个续跑步，点名文档、失效的 anchor 与四个合法出口——经 `replaces: [<同一 id>]` 重写、替换一篇本来就错的文档、经合并退休该论断、或显式 defer。同一篇文档绝不在同一会话内打断两次；那一次打断之后，过期经由 `devflow_read_spec` 的告警与 pre-step 的 spec 索引保持可见，而不再动用强制。

这与 [`dsh-devflow-iron-rules`](../devflow-iron-rules/README.zh.md) 刻意采取相反的节奏——两者共享 turn-stopping 的 hook 形状，不共享任何代码：铁律违规是**义务**，每个脏 turn 都拦，直到修复或到达上限；过期的 spec 文档是**参考**，读者欠它一次知情的过目，不欠它一场拉锯。这里没有重试上限，因为没有什么可重试——重构中途的一次改名让文档合理地过期多个 turn 是一种正当状态，哨兵自己的消息里就是这么说的。

零配置即有意义：没有 `devflowSpec` 缝时哨兵与索引整体惰性（两者都住在随缝进出的条件子上下文里），没有 spec 文档的工作区则永远匹配不到任何东西。

## 什么会触发打断

- 只有成功的一方 `write`/`edit` 落下的文件才算数；路径取自这两个工具的 `file_path` 参数，按发起会话的工作目录解析。
- 只有 `symbol` 与 `content-hash` anchor 参与。`churn` anchor 比较的是提交时间与文档时间——未提交的编辑翻不动它，所以 churn 的健康归 `/devflow spec` 的 census，churn anchor 也绝不出现在哨兵的消息里。
- 只有 `stale` 裁决会武装哨兵。`unevaluable` 意味着一个校验再也跑不动了，那是 census 的关切，不是本 turn 的写入弄坏了某条论断的证据。
- `list()`/`evaluate()` 失败只 warn 并让 turn 正常落定；awareness 层永远不会让一个 turn 失败或卡住。

## pre-step 的 spec 索引

在每个模型步之前，`devflow-spec-map` 运行时上下文列出与本会话所触内容相关的文档——只有索引行（id、新鲜度，锚命中的还带被触文件；从不含正文），指向 `devflow_read_spec`。两层：

- **锚命中层**（尖锐，只看写入）：anchor 声称的文件被本会话写入落中的文档。stale 的排最前并点名失效的 anchor id——被 defer 掉打断的文档恰恰因为仍然 stale 而留在这里可见。
- **scope 层**（宽，读也算）：本会话触过的每个包名下的其余文档，经下述工作区布局解析。读一个文件是"要在这动手"的早期信号。

触达窗口按会话累积，每个集合有固定的近期性上限；渲染出的索引以 `contextMaxBytes` 封顶，超出时先从尾部丢 scope 行、后丢锚命中行，且丢弃必有一行声明。harness 对快照逐步做 diff，索引不变就绝不重发。

## `devflowSpecWorkspace` 服务

本插件发布一个可选的只读服务，把工作区根映射到其成员包：`pnpm-workspace.yaml` 的 `packages` glob（显式路径与一层 `dir/*` 通配、`!` 取反；不支持更花哨的）展开为目录集，每个目录以其 `package.json` 的 name 为键——即其文档所在的 scope id 前缀。没有 `pnpm-workspace.yaml` 的工作区是以根 `package.json` 命名的单包。解析失败只 warn 并给出空布局，绝不报错。消费者用 `ctx.get('devflowSpecWorkspace')` 读取；`/devflow spec` 的 census 用它在零配置下推导 scope 覆盖。

## 组合注意事项

- **与 `devflow-iron-rules` 并存**：两个插件在同一次 stop 上都 steer 时，agent loop 把消息合并进**同一个**续跑步，按监听器顺序送达——不丢失、不覆盖。
- **在 `agent/turn-stopping` 内，本插件只会 steer 或什么都不做。** 在钉住的 harness 版本上，该窗口内的 `inject()` 与 `steer()` 投喂同一个 next-step 列表，同样会把 turn 撑开；被 defer 文档的非打断通道是 pre-step 的 spec 索引。
- spec 索引额外要求 `systemPrompt` 注册表；没有它时，路径收集与哨兵照常运行。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `.devflow/spec` | 供会话推导不出自身根的调用方使用的 spec 根；相对路径按进程 cwd 解析。 |
| `contextMaxBytes` | `2048` | 渲染后 spec 索引的字节上限；超出时先从尾部丢 scope 行，且丢弃必有声明。 |

带会话工作目录的 agent 的 spec 根永远是 `<cwd>/.devflow/spec`，与其他所有 devflow 根同一套推导。
