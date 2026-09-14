# GitHub 本地同步提供者

[English](README.md) | 中文

要求 Node 24 及以上，将 SQLite 数据库放在本机文件系统，不支持 NFS 或跨机器共享。宿主运行即可，不需要保持聊天会话。

加载 `@zhchxiao123/dsh-github-sync-local`，配置 `databasePath`；`apiUrl` 和 `graphqlUrl` 分别指定 REST 和 GraphQL 地址。凭证使用 `env:GITHUB_TOKEN` 这样的引用，环境变量的值仅用于请求头，拒绝 HTTP 重定向。

存在 commands 服务时，可从对话执行：

- `/github-sync add owner/repo issues|discussions|all [env:TOKEN]` 创建订阅；`list`、`pause id`、`resume id` 管理订阅；`update id issues|discussions|all [env:TOKEN]` 修改范围或替换凭证引用。
- `sync id` 同步；`runs [id]`、`show runId` 查看运行进度；`cancel runId` 取消；`resume-run runId` 显式恢复失败或部分完成的运行；`content id` 查看内容。
- `storage` 查看持久化载荷占用；`capacity bytes` 持久化调整容量，多个实例共享配置。
- `consumer subscriptionId name beginning|now` 注册消费者；`cursor` 查询确认位置；`changes subscriptionId name limit` 读取；`ack subscriptionId name sequence` 逐条确认；`replay subscriptionId name beginning|now` 回放。

可选定时器接入 `github.sync` 处理器，参数为订阅 ID。不加载定时器也可手动同步。暂停阻止新承接，不取消现有运行。修改范围前必须结束或取消当前运行；更换仓库应创建新订阅。

Issue、评论、Discussion、评论和回复分别完整分页；排除 PR。增量窗口从上次成功运行的开始时间减去重叠时间计算，并定期全量对账。只有完整成功枚举才标记未出现内容为删除；认证失败、404、GraphQL 错误和中断不推断删除。

SQLite 事务原子提交快照、历史变化和分页进度。运行保留响应检查点，重启后重放已提交页面并继续后续请求；重复页面不产生重复版本。过期持有者和取消后的迟到请求无法提交。卸载会取消请求并等待退出。

容量统计持久化 JSON 载荷，包括保留的响应检查点；SQLite 页、索引和 WAL 会额外占用磁盘。达到容量上限时回滚当前批次，历史消费和回放继续可用。首版不自动清理历史。页面预算耗尽明确显示运行未完成，显式恢复会保留运行 ID 和检查点，并授予下一批页面预算。容量失败会持久化阻止新同步，即使超限批次已经回滚；提高容量后还需显式恢复原运行。容量调整的调用者和时间可查询。

所有部署参数及默认值见导出的 Config 和英文说明。本插件只读 GitHub，不评估问题、不修改 Issue、不启动 agent，也不创建 Devflow 任务。

订阅归属于稳定的 Harness 工作区 `projectId`，GitHub 仓库只是内容来源。新订阅必须指定项目；工具、HTTP 和斜杠命令从真实会话工作区获取身份。订阅、运行、内容、监听及消费者操作在读写前校验项目归属，计划不能关联其他项目的订阅。省略服务层项目参数仅供可信宿主内部使用；存储容量仍是宿主共享资源。

旧订阅保持未归属状态，不会自动执行。`unassignedSubscriptions()` 显式列出；`claimSubscription(id, projectId, actor)` 原子绑定项目、暂停订阅并补充运行快照归属。之前的活动运行保留检查点，转为带 `PROJECT_CLAIM_REQUIRES_RESUME` 的失败状态，需显式恢复。已完成历史和消费者游标均保留；认领后不能重新分配项目。
