# @zhchxiao123/dsh-devflow-tool

[English](README.md) | 中文

模型侧的 devflow 工具：**`devflow_list`** 概览工作区任务看板，**`devflow_show`** 读取单张卡片，**`devflow_create`** 把聊天中商定的需求落成一张新 draft 卡，**`devflow_take`** 认领 ready 卡进入开发，**`devflow_transition`** 提交一次阶段移动，**`devflow_attach_artifact`** 登记阶段产物，**`devflow_read_artifact`** 读回一个 kind 最新的登记。全部是 [`ctx.devflow`](../devflow/README.zh.md) 之上的薄 Consumer；journal 回放、边合法性与拒绝语义都在缝后面，因此结构非法的 journal 会以指明文件与行号的工具错误浮出。每个工具都作用于调用会话的工作区：会话头部带 `cwd` 的 agent 读写 `<cwd>/.devflow`，没有的调用者使用 store 配置的默认根——同一 host 上不同工作区的会话看到不同的看板。

## 契约

`devflow_list({ stage?, parent? })` 返回 `{ cards }`——每张卡的 id、标题、当前阶段、`stageRevision` 与可选的 `parent`，按 id 排序；`stage` 收窄到一个位置（流水线阶段或 `blocked`），`parent` 收窄到一个需求的拆分。它保持精简，并指引模型在移动选中的卡片前先 show。`devflow_show({ id })` 返回卡片标题、阶段、`stageRevision`、可选的 `blockedFrom`、`parent` 及该卡的 `parentTitle`、`children` 摘要、卡片文件路径、已登记产物、可选的当前 artifact-gate 预检与完整 Markdown 正文——因此模型既能理解父子需求，也不必尝试一次 transition 才发现交付物契约。`devflow_read_artifact({ id, kind })` 返回该 kind 最新一次登记——路径、revision、登记阶段与内容；没有登记的卡以稳定的 `no-artifact` 消息报错。

挂载 `dsh-devflow-artifact-gate` 且当前阶段存在已配置、合法的出边契约时，`devflow_create`、`devflow_show`、成功的 `devflow_transition`、成功的 `devflow_take` 与 `devflow_attach_artifact` 都会带上 `artifactGates`：边、各必备 kind 的 `missing | malformed | satisfied` 状态、结构模板、最新登记与缺陷。创建结果还会渲染初始 `stageRevision`，模型无需额外读取即可登记第一份必需产物。创建和成功移动因此立即宣布目标阶段的工作；attach 则在不回滚不可变 journal 登记的前提下立即指出格式错误。没有适用契约时，可选字段及其渲染文本完全省略。

变更类工具要求归属的 agent 会话（非 agent 调用者在产生任何副作用前被拒绝）。`devflow_create({ title, body, slug?, parent? })` 以新分配的顺序号在 `draft` 创建一张卡——正文承载需求与验收标准，省略的 slug 由标题推导，`parent` 把这张卡挂到它所拆解的更大需求下；空标题、格式非法的 slug、输掉的顺序号竞争或非法父卡（不存在、本身是子卡、已结束）以携带缝的稳定消息的工具错误返回。`devflow_transition({ id, to, expectedRevision, reason? })` 解析并提交一次移动；过期的 revision、非法边、缺失的打回理由或策略否决以携带缝的稳定消息的工具错误返回。`devflow_take({ id, expectedRevision })` 取得卡片独占租约并将其从 `ready -> developing`；移动失败会在拒绝到达模型前释放租约，因此失败的 take 无副作用。`devflow_attach_artifact({ id, expectedRevision, ... })` 按当前阶段把阶段产物记入卡片历史，两种形式工具拒绝混用：`path` 登记调用方已写在卡目录下的文件；`kind` 加 `content` 由 store 自行写入 `artifacts/<rev>-<kind>.md`；登记不可变，同一 kind 再次登记写入新的以 revision 命名的文件，读取方取最新。每次移动的权威都是卡片的 `.devflow` journal，而调用 agent 的会话日志本来就以 `tool/call` 与 `tool/result` 记下了每次调用与它的结果；这些工具自己不再追加任何 devflow 形状的会话事件。

## 渲染意图

读取是 `read` 类的 `generic` 卡；变更是 `edit` 类的 `generic` 卡，以关键参数作为 `rawInput`。呈现器是参数的纯函数。

## Model Experience

### Tool schemas

#### What the model sees

生成的 [`devflow_*` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-devflow)：两个读取、建卡，加三个带 revision 校验的变更，描述携带阶段流水线（`draft, designing, ready, developing, reviewing, testing, done` 加 `blocked` 旁路）、一张卡装不下的需求的父子拆分、乐观并发契约与声明的输出 schema。适用的单卡结果还会带上 artifact 预检，并在任一要求未满足时渲染明确的停止流转提示。

#### Token effect

插件激活期间每次请求固定的 schema 成本；结果与列出的卡片或所示卡片正文成正比。

#### KV Cache effect

插件作用域不变时前缀稳定；激活或卸载可能使工具 schema 段及其后的复用失效。

## Known Limitations and Deferred Work

- **无编辑器跟随定位** — 呈现器是调用参数的纯函数，而卡片路径是 Provider 的部署状态，所以 `presentCall` 无法指名卡片文件；show 的结果值以 `path` 字段代替。
- **工具不为已取租约心跳** — `devflow_take` 只认领不做后台心跳；`/devflow takeover` 是遗留持有者的显式恢复平面。
