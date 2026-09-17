# 定时器服务定义

`ctx.scheduler` 提供独立于聊天会话的计划、投递与查询接口。实际存储由 `dsh-scheduler-local` 提供。

处理器实现 `validate`、`accept`、`status`、`cancel`，通过 Cordis effect 注册并释放。`accept` 先按 `triggerId` 持久化去重，再返回运行 ID；接收成功不是运行完成。回执丢失时重试使用相同触发 ID。

管理接口覆盖创建、更新、暂停、恢复、删除、手动触发、取消与历史查询。手动触发独立排队，周期触发在繁忙时合并。参数仅允许 JSON 数据，凭证应以引用传递。

`delivery.cancelRequested` 为必填字段。为 true 时，处理器须原子写入按触发 ID 去重的取消记录，或取消已有运行，并返回运行 ID，禁止启动新工作。迟到的普通接收必须看到该取消记录。在确认收到之前，定时器保持 `CANCELLATION_UNRESOLVED` 并继续重试，不虚报取消完成。

计划归属于稳定的 Harness 工作区 `projectId`，宿主在聊天关闭后仍可执行。新输入必须携带项目身份。管理调用把可信项目作为最后一个参数传入，例如 `list(projectId)`、`history(planId, projectId)` 和按 ID 操作。省略项目仅供宿主内部管理使用；斜杠命令通过真实会话的工作区注册信息解析项目，不回退到全主机操作。

旧计划通过 `listUnassigned()` 显式列出。`claimPlan(id, projectId, actor)` 原子认领计划及其触发历史，同时暂停计划，将尚未完成的投递保留为失败历史。检查后需显式恢复或触发。处理器校验接收项目身份并可异步执行；接收、状态查询和取消均传递同一持久化项目。GitHub 处理器在保存计划和实际投递时均拒绝跨项目订阅。
