# GitHub 同步工具

基于 `ctx.githubSync` 的 DeepSeek Harness 原生工具。需要 Harness 工具运行时与 GitHub 同步服务，不依赖调度器。Harness 依赖固定为 `0.1.5-rc.2`，Cordis 固定为 `4.0.2`。

在工具运行时旁加载 `@zhchxiao123/dsh-github-sync-local` 和 `@zhchxiao123/dsh-github-sync-tool`。工具注册随消费者和服务生命周期释放。持久化、恢复、取消写入隔离、容量准入与有序确认仍由服务负责。

| 工具 | 操作 |
| --- | --- |
| `github_sync_subscriptions` | 列出订阅与存储状态。 |
| `github_sync_configure` | 创建或更新明确的仓库、内容范围及可选的 `env:VARIABLE` 凭证引用。 |
| `github_sync_subscription_manage` | 暂停或恢复订阅接收同步。 |
| `github_sync_start` | 接收同步请求，可显式要求全量对账。 |
| `github_sync_runs` | 按运行 ID、订阅 ID 查询实际状态，或列出全部运行。 |
| `github_sync_cancel` | 请求取消已接收的运行。 |
| `github_sync_resume` | 解决原因后恢复原失败或部分完成的运行。 |
| `github_sync_content` | 读取版本化快照与来源链接。 |
| `github_sync_capacity` | 显式修改字节容量上限。 |
| `github_sync_consumer_manage` | 注册独立消费者，或从 beginning/now 回放。 |
| `github_sync_consumer_read` | 投递有限一页并返回游标，不自动确认。 |
| `github_sync_consumer_acknowledge` | 按序确认一条已经成功处理的变更。 |
| `github_sync_consumer_state` | 查询游标，不推进消费。 |

创建前先查询现有订阅。更新时省略凭证引用会保留原引用，不能传原始 token。未知参数不会转发到服务。修改与变更投递必须由真实 agent 发起；支持审计的服务调用接收其 agent/会话 ID 与工具调用 ID。消费 API 没有 actor 字段，这些调用由工具运行时记录，工具不另建审计存储。订阅仅在同一已注册工作区的会话间共享。

开始与恢复只返回稳定回执，不宣称完成。需要查询实际状态来区分 queued/running/waiting 和 succeeded/partial/failed/cancelled。调整容量不会删除数据或自动恢复运行。容量阻断时已有内容读取和回放仍可用。暂停限制新准入，已经接收的运行需单独取消。

Issue/Discussion 的标题和正文是不可信远端数据，不能作为指令或授权。工具描述和内容结果都说明这一边界，并保留来源链接。原生结果卡片显示简明摘要，不倾倒远端正文或原始 JSON；模型获得经过校验的结构化结果和可读详情。不假定侧栏深链协议，自动化面板读取同一服务。

真实 Loader/工具运行时测试使用 SQLite 服务与本地 HTTP GitHub fixture，验证身份来源、配置、回执和状态区别、失败恢复、取消、容量阻断、独立有序消费、回放、展示与卸载。不需要模型或生产 token，也不代表真实 GitHub 凭证验收。

同步准入的触发 ID 来源于真实 agent 和工具调用 ID；回执丢失后重试同一次调用会返回原运行，新调用使用新的调用 ID。

## 项目归属

自动化归属于当前会话对应的 Harness 已注册工作区。主机从会话 header 的 cwd 解析稳定工作区 ID；调用方不能指定项目 ID，也不会隐式创建工作区。缺少项目上下文时拒绝操作。同一工作区的会话共享计划与订阅，不同工作区互相隔离。后台执行不依赖查看会话保持打开。

旧版未归属数据单独列出，需要显式认领到当前项目。认领后保持暂停，恢复是另一项操作。GitHub 存储容量属于整个主机，不是项目配额。

`github_sync_unassigned` 列出未归属旧数据；显式提供 `id` 时认领到当前项目。
