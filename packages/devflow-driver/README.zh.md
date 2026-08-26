# @zhchxiao123/dsh-devflow-driver

[English](README.md) | 中文

[`ctx.devflow`](../devflow/README.zh.md) 缝的阶段驱动器：把已提交的 `devflow/stage-changed` 移动变成一次性 subagent 派发的纯 Consumer。每个配置的阶段指定一个已注册的 subagent provider 与可选 instructions；驱动器认领卡片租约（过期租约接管并以 `claim-expired` 条目入 journal），启动一个以卡片为目标的子代理，在子代理运行期间以过期窗口三分之一的间隔心跳续约，子代理失败或无法启动时把卡片停驻 `blocked`。认领、读取与停驻移动全部跟随被移动卡片自己的 `root`，多工作区 host 上一个工作区的卡绝不会串到另一个工作区的目录。子代理自己经 devflow 工具推进卡片——驱动器绝不向前移动卡片。

## 行为

激活时驱动器扫描一次看板，已停在被驱动阶段的卡片无需等下一次移动即可派发（扫描失败仅告警；监听器继续驱动）。派发在 `maxConcurrentCards` 上限下按到达顺序排队；租约被其他 worker 新鲜持有的卡片跳过，已接入的卡片绝不二次派发。拆分成子卡的卡片同样跳过——可执行的工作由子卡承载，需求本身绝不会成为某个子代理的 objective；完全列不出看板时也跳过，因为把一张可能是父卡的卡片派发出去是更坏的失败。revision 倒退的 `stage-changed`（分支切换回放旧状态）触发静默重扫而非派发。已卸载驱动器的子代理经 start 信号中止，持有的租约释放，不再派发。所有派发共享一个合成的、从不被提示的父 agent（`devflow-driver-<pid>`）作为子代理谱系锚点。

## 配置

```yaml
- id: devflow-driver
  name: '@zhchxiao123/dsh-devflow-driver'
  config:
    stages:
      ready:
        provider: spawn
        instructions: Take the card into development.
    maxConcurrentCards: 2
    claimStaleAfterMs: 300000
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `stages` | `{}` | 按进入的阶段派发；`done` 与 `blocked` 不可驱动。 |
| `maxConcurrentCards` | 必填 | 并发驱动卡片上限；更多卡片排队。 |
| `claimStaleAfterMs` | `300000` | 心跳早于该窗口的租约被接管。 |

不可驱动的阶段名、未注册的 provider 或非正上限使加载失败。

## Model Experience

### Child objective prompt

#### What the model sees

每个被派发子代理的用户消息由以下部分组成：配置的阶段 `instructions`（如有）、一行 `You are driving devflow task card <id> at stage "<stage>" (revision <n>).`、卡片标题与 Markdown 正文、以及固定的收尾契约——告知子代理用 `devflow_transition` 推进卡片（先用 `devflow_attach_artifact` 登记产物），无法推进时带理由移入 `blocked` 而不是猜。

#### Token effect

每张被派发卡片一条 prompt，规模与卡片正文加固定契约行成正比；驱动器不给任何其他请求增加内容。

#### KV Cache effect

独立：每次派发是全新的子会话，其请求与父会话或其他卡片不共享前缀。

## Known Limitations and Deferred Work

- **单一执行体类型** — 每个被驱动阶段都派发一次性 subagent；PRD 的同会话 `goal` 与 fresh-agent Ralph 执行体等驱动器能为每张卡拥有活跃宿主 agent 后再来。
- **子代理工具集是部署的责任** — 驱动器不校验所选 provider 的子代理能否看到 devflow 工具；看不到的子代理只能汇报，卡片原地不动。
- **激活扫描只覆盖默认根** — 其他工作区根的卡经各自的 `stage-changed` 事件派发；已停在其他根被驱动阶段的卡要等它的下一次移动。
