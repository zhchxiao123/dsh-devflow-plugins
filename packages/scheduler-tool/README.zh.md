# 定时调度工具

基于 `ctx.scheduler` 的 DeepSeek Harness 原生工具，可独立搭配符合约定的调度服务加载。使用已发布的 Harness `0.1.5-rc.2` 和 Cordis `4.0.2`。

在 profile 中加载 `@zhchxiao123/dsh-scheduler-local`、Harness 工具运行时和 `@zhchxiao123/dsh-scheduler-tool`。消费者或必需服务卸载时工具随之释放。工具不持有定时器，也不维护额外状态机。

| 工具 | 操作 |
| --- | --- |
| `scheduler_query` | 列出计划与投递历史，可按计划 ID 筛选。 |
| `scheduler_configure` | 创建或替换计划配置，支持固定毫秒间隔或带 IANA 时区的 Cron。 |
| `scheduler_manage` | 暂停、恢复或删除计划。 |
| `scheduler_trigger` | 立即投递计划，或按触发 ID 请求取消。 |

先查询，再配置。GitHub 同步使用 `github.sync` 处理器，参数必须为 `{"subscriptionId":"..."}`。其他已注册处理器可以使用自己的无损 JSON 参数。服务校验周期、超时、重试预算与处理器参数。更新会替换配置，需保留不应改变的设置。删除计划会停止未来调度，已经接收的运行需要单独取消。

修改要求实际拥有本次调用的 agent。actor 来源于其会话/agent ID 与工具调用 ID，模型参数不能冒充身份；未声明字段不会转发给服务。这些计划属于宿主层，同一服务的会话共享可见。

原生调用卡片展示操作与相关标识或规则，结果卡片只展示简明摘要；模型同时获得经过校验的结构化结果与可读详情。触发回执不代表下游完成：通过 `scheduler_query` 查询，再用处理器的运行工具跟进 `runId`。自动化侧栏展示相同服务状态，工具不假定宿主支持任意侧栏 URL。

测试使用真实 Cordis Loader、已发布的工具运行时和 SQLite 服务，验证持久化、输入失败、身份来源、回执、取消、原生展示与卸载。不需要模型或真实 GitHub 网络请求。
