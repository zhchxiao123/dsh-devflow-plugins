# Devflow 页面 Web 验收（Midscene）

## 当前契约

目标是本机受保护的 Harness Web GUI `http://127.0.0.1:3082`。`devflow-board.suite.json` 保留看板与卡片详情两条视觉断言，显式打开右侧栏、Devflow 和列表视图；登录快照不会保留面板展开状态。

- 构建探针为认证后的 POST `/devflow/api/build-info`，检查 JSON 的 `value.buildId`、`value.instanceId` 以及服务宣告的 UI 字节摘要。buildId 来自本地构建产物，不能从目标探针抄一个值来证明部署正确。
- 登录使用工作区外、仅当前用户可读的 Playwright storage state。快照同时应用于探针及各用例。启动 token 不进入 suite、工具参数、报告或 Git。
- 托管 profile 从 Harness 公共凭证服务读取 `OPENAI_API_KEY`，显式配置视觉模型与端点；不要求用户再写含密钥的 .env。
- 本地 `glm-5.3-flash:cloud` 返回像素坐标，已用 `gpt-5` 协议适配完成真实受保护 UI 探索；`glm-v` 的归一化坐标约定不适用于这个已测试端点。
- 正式 suite SHA256 与部署回执由维护者固定。源码指纹排除根 `.devflow` 运行状态；suite 必须位于该目录外。源码、suite、构建实例、报告变化均使验收不可用。

## 从对话验证

在这个工作区的 Harness 会话中依次请求：

1. “调用 midscene_doctor，profile 使用 local，列出预检结果。”
2. “用 midscene_browser 打开 Devflow 面板并切到列表，检查任务卡片可见；等待作业结束并打开截图。”探索用于排错，不满足完成门禁。
3. “调用 midscene_run，对关联重验收卡运行 local 的已批准套件；等待作业结束，检查报告后通过 devflow_attach_artifact 登记 test-report。”
4. 请求合法完成转移；必需的 `midscene:local` validator 会另起新 run，不复用手动检查结果。不能为了通过而修改 suite 预期或撤销策略。

卡片详情展示配置摘要、最近预检、正式验收结果和报告；作业读取、等待、取消仍使用 Harness 现有 job 工具。宿主重启后，`midscene_inspect` 读取历史，`midscene_recover` 只清理确认归属的中断探索，不重放动作。

## 本地运行记录

隔离运行目录：`../.scratch/midscene-runtime`（相对本 worktree）。配置、登录快照、构建回执、产物和验收报告均在其中；不要复制其中的凭证或登录数据到仓库。

最终包哈希、安装检查、真实正负向 runId 和剩余限制记录在该目录的 `remediation-verification.md`。旧卡 0001 的失败运行 `5891d8fd-6bd9-4609-827c-381f3b2bfbe9` 及原 journal 保留；修复后以关联重验收卡承接，不伪造 done→testing 转移。0004 仅证明旧门禁实验，不能当作页面验收成功。

## 取消与错误断言

`cancel-cleanup.suite.json` 保留原有 SSE 阻塞探针 fixture，它设计上不能通过，只验证取消后的进程清理。负向视觉验证使用独立临时场景，不能篡改正式已批准套件。

只有完整 `passed`、断言计数齐备且报告与清理均有效才算一次通过。`assertion-failed`、`infrastructure-error`、`cancelled`、`timed-out`、`interrupted` 与 `unknown` 如实区分。发布门槛还需要全部工程检查和真实门禁证据，不能用单次探索成功替代。
