# 自动化 Web

[English](README.md) | 中文

为原生自动化与 GitHub 订阅侧栏提供项目级管理 HTTP 接口。计划、运行、快照和恢复仍由 scheduler 与 GitHub sync 服务负责。两个服务都不依赖本包，也不要求另一个能力加载。

将 `@zhchxiao123/dsh-automation-web` 与 `@deepseek-ai/dsh-host-webserver` 及任一可选提供者一起加载。`trustedHosts` 默认允许回环地址；非回环地址应与 Harness Web 接口保持相同配置。由于 Harness 实现不公开导出，本包按已发布的 Devflow Web 边界复述信任规则。这是浏览器来源防护，不是用户认证。

`POST /automation/api` 接受严格 JSON 请求，最大 64 KiB。成功返回 `{ ok: true, data }`，拒绝返回 `{ ok: false, error }`。固定领域错误保留可操作原因，未知异常不暴露驱动路径或凭证。宿主依据受信 HTTP 地址生成审计身份，拒绝调用者传入 actor 字段。

| 方法 | 输入 | 结果 |
| --- | --- | --- |
| `overview` | 无 | 能力可用性、计划、触发、订阅、运行、存储 |
| `content` | `subscriptionId` | 内容快照 |
| `plan.save` | 可选 `id`、`input: PlanInput` | 创建或更新后的计划 |
| `plan.action` | `id`、`action: pause/resume/remove/trigger/cancel` | 触发回执或 null；cancel 使用触发 ID |
| `subscription.save` | 可选 `id`，`input` 内包含仓库、范围和可选凭证引用 | 订阅；仓库身份不可修改 |
| `subscription.action` | `id`、`action: pause/resume/sync` | 订阅或持久化运行回执 |
| `run.action` | `id`、`action: cancel/resume` | null 或原运行回执 |
| `capacity.set` | 正数 `bytes` | 存储用量与审计身份 |

凭证输入仅接受 `env:VARIABLE` 引用。运行已接收不等于已完成：通过 `overview.runs` 读取持久化进度和结果。外部内容仍是不可信文本，由 UI 安全展示。恢复沿用原运行与检查点；若范围或更新内容已变化，提供者可能拒绝恢复。

`./client` 导出的浏览器安全函数 `automationRequest(request, signal?)` 验证响应信封及各方法的数据结构。刷新和中止生命周期由调用者管理。卸载本插件释放路由，已接受的工作仍由提供者负责。

测试启动真实提供者、WebServer 与 Cordis Loader，通过浏览器解码器驱动 HTTP。仅外部 GitHub 服务使用 fixture。覆盖来源拒绝、schema 与正文限制、能力缺失、原运行恢复、身份来源和路由卸载。

## 项目归属

自动化归属于当前会话对应的 Harness 已注册工作区。主机从会话 header 的 cwd 解析稳定工作区 ID；调用方不能指定项目 ID，也不会隐式创建工作区。缺少项目上下文时拒绝操作。同一工作区的会话共享计划与订阅，不同工作区互相隔离。后台执行不依赖查看会话保持打开。

旧版未归属数据单独列出，需要显式认领到当前项目。认领后保持暂停，恢复是另一项操作。GitHub 存储容量属于整个主机，不是项目配额。

所有方法必须提供 `sessionId`。`unassigned` 单独返回旧计划与订阅；`claim` 接收 `kind: plan|subscription` 和 `id`，将记录认领到当前项目。计划输入不接受 `projectId`，由主机解析。
