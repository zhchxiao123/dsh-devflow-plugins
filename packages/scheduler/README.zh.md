# 定时器服务定义

`ctx.scheduler` 提供独立于聊天会话的计划、投递与查询接口。实际存储由 `dsh-scheduler-local` 提供。

处理器实现 `validate`、`accept`、`status`、`cancel`，通过 Cordis effect 注册并释放。`accept` 先按 `triggerId` 持久化去重，再返回运行 ID；接收成功不是运行完成。回执丢失时重试使用相同触发 ID。

管理接口覆盖创建、更新、暂停、恢复、删除、手动触发、取消与历史查询。手动触发独立排队，周期触发在繁忙时合并。参数仅允许 JSON 数据，凭证应以引用传递。

`delivery.cancelRequested` 为必填字段。为 true 时，处理器须原子写入按触发 ID 去重的取消记录，或取消已有运行，并返回运行 ID，禁止启动新工作。迟到的普通接收必须看到该取消记录。在确认收到之前，定时器保持 `CANCELLATION_UNRESOLVED` 并继续重试，不虚报取消完成。
