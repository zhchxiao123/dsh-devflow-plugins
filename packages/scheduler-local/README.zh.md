# 本地持久化定时器

`ctx.scheduler` 的 SQLite 提供者，要求 Node.js 24 或更新版本。宿主运行时无需保持聊天会话；宿主退出期间不执行，重启后从持久化记录恢复。

配置包括 `databasePath`（默认 `.scheduler/scheduler.sqlite`）、`pollIntervalMs`（1000）、`leaseMs`（30000）、`retryMs`（1000），时间单位为毫秒。同一数据库必须位于本地文件系统，多实例通过租约和执行代次协调；不支持跨机器或网络文件系统集群。

命令入口：`/scheduler list`、`create <JSON>`、`update <id> <JSON>`、`history [planId]`、`pause/resume/remove/trigger <id>`、`cancel <triggerId>`。加载 Harness commands 服务后自动出现，卸载插件时释放。

计划输入包含名称、处理器标识、JSON 参数和时间规则。固定间隔保留原始时间锚点；五字段 Cron 指定 IANA 时区，跳过不存在的本地时间，避免夏令时回拨重复触发。补触发支持 `latest` 和 `skip`；手动请求使用独立标识排队，周期请求在繁忙时合并。

处理器必须先持久化按触发 ID 去重的接收记录，再返回运行 ID。接收与完成分别显示，接收后的失败由下游管理。暂停和删除计划不取消已接收运行；取消必须显式发起，保留已提交的下游数据。

历史默认保留。处理器异常仅记录通用错误码，参数应使用凭证引用，不应传入密钥。详见英文 README 的配置表和服务定义包中的处理器协议。

计划参数必须是可无损保存的普通 JSON。函数、Symbol、BigInt、嵌套 undefined、非有限数字、负零、访问器、代理、自定义原型、稀疏或扩展数组及循环引用均在保存前拒绝。处理器校验获得独立副本，不得改变实际保存的参数快照。
