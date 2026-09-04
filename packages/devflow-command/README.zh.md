# @zhchxiao123/dsh-devflow-command

[English](README.md) | 中文

面向人的 `/devflow` 干预命令，作用于 [`ctx.devflow`](../devflow/README.zh.md) 任务卡能力缝。插件通过 [`ctx.commands`](../../interaction/commands/README.zh.md) 注册一个全局命令，任何已组合的命令适配器都能发现并执行它，全程没有模型轮次。这是 devflow 设计中的确定性平面：模型经 [`dsh-tool-devflow`](../tool-devflow/README.zh.md) 移动卡片，Web 头部看板只读渲染，而 `/devflow` 承担绝不能依赖模型的干预——查看、阶段移动、租约驱逐与归档。所有入 journal 的效果都携带 actor `{ "kind": "command", "name": "devflow" }`。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/devflow` | 看板：每张活跃卡一行——id、位置（blocked 卡显示被打断的阶段）、revision 与标题。子卡缩进排在它所拆解的需求之下；父卡已离开活跃集的子卡在自己那一行保留反链。看板为空时明确说明。 |
| `/devflow show <id>` | 单张卡：其看板行、父卡反链或缩进的拆分清单、已登记产物与 Markdown 正文。 |
| `/devflow move <id> <stage> [reason]` | 按卡片当前 revision 经普通执行器提交一次流转。边合法性、打回 `reason` 要求与 `devflow/transition` 门禁照常裁决——命令没有旁路；领域拒绝把缝的消息作为直接错误返回。 |
| `/devflow takeover <id>` | 强制接管租约：任何过去的心跳都算过期，驱逐以 `claim-expired` 入 journal，租约随即释放，被驱逐持有者下一次带 revision 检查的提交会失败。 |
| `/devflow archive` | 把每张 `done` 卡移入档案并报告归档的 id。 |
| `/devflow spec` | 报告架构文档健康度：多少篇 fresh、哪些 stale 或 unevaluable **以及具体是哪条 anchor 失效**、哪些期望的 scope 没有任何文档覆盖。只读；未挂载文档缝时返回错误而不是一份空报告。 |

未知子命令、畸形参数表、或既非阶段也非 `blocked` 的目标，都在触碰存储之前返回直接的用法错误。

每个子命令都作用于发起会话的工作区根：会话头部带 `cwd` 的读写 `<cwd>/.devflow`，没有的使用 store 配置的默认根——同一会话的 `/devflow` 与模型工具因此永远看到同一张板。

## 组合

生产者注入 `commands` 与 `devflow`。自定义应用挂载二者的所有者加本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: devflow
  name: '@zhchxiao123/dsh-devflow-filesystem'
- id: command-devflow
  name: '@zhchxiao123/dsh-devflow-command'
  config:
    # 本工作区期望被文档覆盖的 scope 根。只有 `/devflow spec` 读它，
    # 且只用于报告缺口。
    specScopes: ['@scope/pkg-a', '@scope/pkg-b']
```

`specScopes` 是配置而非发现，因为缝无从知道这里什么算一个「包」——那是工作区布局问题，猜错的地方就会报出一个假缺口。什么都不配时，报告会说「覆盖率这个问题没有被问」，这与「没有缺口」不是一回事。

`/devflow spec` 以 `ctx.devflowSpec` 机会性读取，并**从缝已有的读面推导**报告——每篇的汇总新鲜度，加上对非 fresh 篇目的逐条 anchor 裁决——因此 store 不为一个消费者想要的报告新增任何方法。它的收尾是一条指令而不是一份清单：列完伤亡就结束，只会训练所有人接受一个正在悄悄腐化的文档集。

## Model Experience

### Human `/devflow` intervention

#### What the model sees

Nothing directly: the slash input and its direct output are absent from model requests. A committed intervention lands in the card journal, so a model that later reads the board through the `dsh-tool-devflow` tools sees the new location and the `command devflow` actor like any other journal history.

#### Token effect

None. Board and card output is direct command text; later devflow tool reads bill as those tools' results.

#### KV Cache effect

None; command discovery, execution, and output never enter a provider request.

## Known Limitations and Deferred Work

- **不能建卡或编辑卡** — 命令只干预已存在的卡；`card.md` 及其 journal 的创作在能力缝之外。
- **接管信任心跳时间戳** — 过期判断是严格的年龄比较，同一毫秒写入或携带未来时间戳的心跳仍算存活，此时接管会改为报告持有者。
- **命令适配器只随 Web 客户端交付** — headless、ACP 自动化与 JSON-RPC 应用不消费 `ctx.commands`；在那些组合里，干预走模型工具或直接改磁盘。
