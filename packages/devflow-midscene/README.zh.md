# @zhchxiao123/dsh-devflow-midscene

[English](README.md) | 中文

可选的 Web 验收包。`devflow-midscene-browser` 通过固定版本的官方 CLI 排查页面；`devflow-midscene-acceptance` 运行认可的用例、登记报告并请求完成门禁。加载插件不会启动浏览器或调用模型；本包独立于默认 Devflow bundle 安装。

## 当前项目工作流

安装并加载插件后，直接让 Harness Agent 检查当前项目或验收对应的 Devflow 任务，不需要全局 workspace profile。Agent 使用 `midscene_discover`、项目运行手册和已有 shell/job 工具发现或启动应用，并验证实际地址。静态探索读取常见项目脚本、显式 Vite 端口和已有用例；它自身不扫描端口、不启动服务。多个应用无法区分时才需要选择。

`midscene_project` 将可移植选择保存在 `.devflow/midscene/settings.json`，用户无需手工编辑。可以保存应用、目标覆盖或已配置的 DSH 模型引用，不能保存密钥。未指定时使用发起请求的会话模型。已知 Midscene family 自动识别，未知别名需要经过验证的 family。元数据检查不能证明视觉操作效果。设置、用例与 `validation.json` 属于部署策略，应当进 git；本包的锁文件不应当——该根目录下每一条路径的权威是[`.devflow` 的提交语义](../../docs/devflow.zh.md#devflow-commit-semantics)。

每次运行创建经过认证的本机桥接，通过 DSH 已发布的 LLM/附件服务发送截图和请求，真实模型密钥留在 DSH。运行期间固定 provider/model 选择，每个请求单独绑定 prepareCall；公开接口不能在整个运行期间固定同一个连接版本。Midscene 通过提示词和解析器验证结构化响应，不要求传输层 JSON mode。附件若被缩放则明确拒绝，以避免坐标错误。

通过 `midscene_browser` 探索页面。通过 `midscene_bind` 绑定实际任务、已评审用例和已有私有部署回执，再调用 `midscene_run`。工具自动计算摘要，对变化的绑定请求审批。候选用例可存入 `.devflow/midscene/suites/`。门禁引擎读取自动写入的 `.devflow/validation.json`；Midscene 提供者未加载时，必需验收仍阻止完成。绑定前必须加载门禁引擎。首次回执须来自真实部署流程，不能通过复制远端 build id 生成。

项目运行通过 Devflow 关联报告。报告使用经过认证的 Harness 相对地址，无需配置报告主机。运行数据在 Harness 私有目录中按规范化工作目录隔离，不同 worktree 不混用。查看历史与清理不依赖当前模型或地址。不会自动复制用户浏览器登录态，需遵循项目授权登录流程；显式旧 profile 支持私有登录快照。

`midscene_project` 的 `migrateProfile` 复制匹配旧 profile 的安全选择。默认选择优先使用项目设置，显式旧 profile、全局 YAML 和历史报告继续可用。设置操作崩溃可能遗留 `.devflow/midscene/operation.lock`，确认记录中的进程已经退出后再删除该锁。该锁绝不提交——随分支到达的副本点名的是一个从未在本 checkout 跑过的进程。文件系统检查不是对抗同用户恶意目录竞态的内核沙箱。

正式项目绑定需要带 `field` 和 `instanceField` 的 JSON 构建探针；文本标记无法识别相同构建的服务重启，因此会在审批前拒绝。可选项目 `limits` 设置控制超时、清理超时与步数，无需编辑全局 profile。

## 旧版工作区 profiles

`project` 名称保留给自动项目上下文；旧 profile 请使用其他名称。profile 的 `workspace` 是一个固定的绝对路径，因此在 git worktree 中开发的卡只能用 project 模式验收。

在插件的 `profiles` 配置中声明工作区与验收环境。凭证字段填 Harness 已配置的引用名；不填密钥值。对话模型与视觉模型可以相同，但必须明确配置 Midscene 支持的模型家族和兼容接口。

```yaml
profiles:
  local:
    workspace: /absolute/project
    output: /absolute/acceptance-results
    targetUrl: http://127.0.0.1:3082
    reportBaseUrl: http://127.0.0.1:3082
    provider: openai
    model: glm-5.3-flash:cloud
    family: gpt-5
    baseUrl: http://localhost:11434/v1
    credentialRef: OPENAI_API_KEY
    browserMode: puppeteer
    storageState: /private/path/login.json
    suite: e2e/acceptance.json
    suiteSha256: <认可的用例文件 SHA256>
    buildId: <部署收据中的 buildId>
    deploymentRecord: /private/path/deployment.json
    timeoutMs: 180000
    cleanupTimeoutMs: 10000
    maxSteps: 30
```

`credentialRecord` 可以替代 `credentialRef`，读取公开凭证服务中的 `scope/id` API-key 记录；不解析授权 grant。模型配置每次运行重新解析，不修改宿主全局环境变量。`provider` 用于查询已发布模型能力，endpoint/family 仍须显式匹配。没有构建与套件配置时也可以探索页面，不能做正式验收。

对话中调用 `midscene_doctor` 检查配置，再使用 `midscene_browser`（可选动作 prompt 与视觉 assertion）或 `midscene_run`（card/profile）。两个执行入口都返回现有 Harness job；等待并读取结果后再操作，使用 job 工具取消。`midscene_inspect` 可在重启后读取历史，未结束记录显示 unknown，不自动重放操作。

默认模式为每个 job 建立专用 Chromium，并让官方 CLI 通过 CDP 连接；不共享官方 CLI 的全局临时目录。也支持显式配置 `browserMode: cdp` + `cdpEndpoint`，或 `browserMode: bridge`。借用模式会操作当前目标标签页，先选择专用测试标签；它不自动连接 Codex 内置浏览器。结束时停止本次代理并断开连接，不关闭借用的 Chrome。登录快照仅适用于自有浏览器，不会注入借用的个人会话。

正式门禁在 devflow-gates 中启用：

```yaml
requiredValidators:
  - root: /absolute/project/.devflow
    edges: [testing->done, reviewing->done, developing->done]
    validators: [midscene:local]
    timeoutMs: 180000
```

策略只覆盖指定工作区，可用 `cards` 限定已有卡片。插件必须启用；required validator 缺失、取消或验收失败均拒绝。人工/无会话转移不能冒充拥有者运行验收。门禁重新运行套件，旧 passed 和 LLM allow 不替代机械结果。`suiteSha256` 与部署策略由维护者认可，agent 不应修改它们绕过失败。

在 devflow-web 配置 `acceptanceReports: [{workspace: /absolute/project, output: /absolute/acceptance-results}]` 后，job 结果提供按会话授权的报告链接。HTML 在隔离权限下打开；浏览器 profile、cookie 与临时端点文件不提供下载。未配置 reportBaseUrl 时返回本地文件链接，不猜测被测应用就是 Harness。

官方 Skill 原文与许可证固定在 [official-browser](assets/official-browser/PROVENANCE.md)，Harness 适配保留在独立技能文件。不会在运行时安装浮动版本。

## 独立 CLI：安装与准备

在承载用例的项目中安装并固定本包版本，通过项目脚本调用本地 CLI；在 Harness profile 安装同一包以发现技能：

```sh
dsh plugin --profile acceptance add @zhchxiao123/dsh-devflow-midscene
pnpm add -D @zhchxiao123/dsh-devflow-midscene@0.4.0-dev.7 playwright@1.63.0
pnpm approve-builds # 若 pnpm 阻止了构建脚本，选择 sharp
pnpm exec playwright install chromium
```

未发布版本在两处使用同一个本地 tarball。安装补丁加载插件，托管执行需要公开的 tools/jobs/credentials 服务。SDK 固定 Midscene `1.12.6`、Playwright `1.63.0`；本仓库使用 Node `24.18.0`。CI 在无凭证 SDK 集成测试前安装匹配的 Chromium；Linux 可能需要 `playwright install --with-deps chromium`。

先准备应用启动、检查和停止 runbook，再复制[用例模板](assets/suite.example.json)，替换目标、构建探针、任务和预期结果，纳入版本管理。模板不证明某个 profile 已有这些路由或任务。构建探针支持纯文本 GET，也支持 POST JSON，例如 `{"path":"/devflow/api/build-info","expected":"<buildId>","method":"POST","format":"json","field":["value","buildId"],"instanceField":["value","instanceId"]}`。实际响应必须匹配部署收据，传入 id 本身不构成证据。

Devflow 的构建身份需要 devflow-web 的 `buildClient: {artifact: "/absolute/installed/devflow-ui/lib/client.js", entry: "@zhchxiao123/dsh-devflow-ui"}`；实际客户端 URL 从运行实例的客户端模块图获取。服务端读取已加载 web bundle 和指定 UI bundle 的摘要，worker 另行验证所服务 UI 文件的实际字节。源码模式、产物缺失或启动后变化均不可用。收据是部署时从本地构建产物生成的 `{version:1,commit,workspaceSha256,buildId}`，不能把远端探针读数抄作期望。当前 buildId 覆盖 Web 通道和 UI bundle；完整插件集另用部署清单保存包哈希。

CLI 可用 `--storage-state /private/login.json` 与 `--deployment-record /private/deployment.json`。两个文件必须位于工作区外，POSIX 权限仅限当前用户；登录快照只允许被测源的 cookies/localStorage。快照同时用于探针和每个隔离用例。正式托管运行强制收据与认可的 suite 哈希。

在参数之外配置 `MIDSCENE_MODEL_BASE_URL`、`MIDSCENE_MODEL_API_KEY`、`MIDSCENE_MODEL_NAME` 及模型家族设置。使用 Midscene 支持的接口；CLI 不会从 Harness 的 `ctx.llm` 自动获取凭证。用例和 URL 不应含凭证。

## 独立 CLI：运行与检查

选择 Git 工作区**之外**的持久可写输出目录，避免证据写入改变输入指纹。工作区必须是有提交的 Git 根目录，指纹包含已修改和未跟踪的源文件；每次运行创建唯一子目录。

```sh
pnpm exec dsh-midscene run \
  --suite ./e2e/acceptance.json --workspace "$PWD" \
  --output /absolute/path/to/acceptance-results \
  --card 0001-midscene-acceptance --build-id tested-build-id \
  --model "$MIDSCENE_MODEL_NAME" \
  --timeout-ms 120000 --max-steps 30 --cleanup-timeout-ms 5000

pnpm exec dsh-midscene inspect --run /absolute/path/to/acceptance-results/run-id
```

`--browser-executable-path` 可指定 Chromium，优先使用 Playwright 安装的匹配版本。独立 CLI 的 `--report-base-url` 可指定提供**输出根目录**的 HTTP(S) 服务，生成的链接会追加 run id；不设置则使用本地文件 URL。它与托管 profile 的 reportBaseUrl 含义不同：后者使用已认证 Harness 报告路由。独立 CLI 会核对链接实际字节；服务器不可达、返回兜底页或文件迁移会使证据不可用。检查命令可通过 `--timeout-ms` 指定此步骤时限。

JSON 用例包含 `version: 1`、`name`、`baseUrl`、`buildProbe: {path, expected}` 和非空 `cases`；每个 case 有唯一 `id` 与非空 `steps`。步骤支持 `goto`（`path`）、`act`（`prompt`）、`assert`（`prompt`）和确定性 `text`（`selector`、`expected`）。用例集必须有视觉断言，显式导航与构建探针不能跨声明的源。`--max-steps` 限制用例步骤及每个自主动作的重规划次数；`--timeout-ms` 限制实际耗时，这些不等于货币预算。

长运行使用 Harness shell 的后台模式，并通过现有 job 读取/停止工具控制。SIGINT/SIGTERM 请求关闭，超过清理期限后升级终止；不能确认的清理不标为确认。只有完整通过且所需报告齐备时 CLI 才返回零；缺配置、失败、部分执行、超时和取消均返回非零。

## 证据与 Devflow

每次运行记录 manifest、有限的 case 结果、Markdown 摘要、报告索引及可用的 SDK HTML/截图。manifest 包含源码、工作区、用例身份，已核对的服务构建，SDK/模型、计数、时间、结果和清理状态。可用模型 token 统计独立于 Harness 计费；缺失统计保留为不可用。HTML 与截图可能含测试数据，按项目测试数据规则保留。

读取生成的 `test-report.md`，重新读取卡片 revision，通过 `devflow_attach_artifact` 的 `kind: test-report` 与 `content` 登记。外部 HTML 路径不是卡片内 artifact 路径，禁止绕过 store 写保护。输出目录被迁移或清理后，缺失报告仍应视为证据不可用。

为适用的完成边配置**重新运行**项目验收命令，不用 `inspect` 缓存放行。区分门禁运行与先前检查的 run id。命令门禁不能在卡片转移期间登记同一卡片的产物；失败后通过普通工具调用检查和登记。express/emergency 捷径以及父卡集成验收需显式确定策略。

`inspect` 只读。原进程丢失后的非终态记录属于未知，不推断通过、不恢复执行。重复有副作用的动作前先检查现场。完成报告在进程退出后保留，但本包不承诺跨重启继续 job、卡片托管 HTML 附件、报告服务器、原生 UI 操作工具或移动端。

## 验证

测试使用真实 SDK、Chromium 与受控模型传输，同时覆盖真实 Loader/技能及 shell/工具/Devflow 门禁组合。受控响应证明解析和生命周期行为，**不能证明视觉模型判断准确**。M1 还需实际视觉模型运行及目标 Devflow UI/profile 验收，单独记录其结果，不能以构建或无凭证测试代替。

### 受保护部署的验收

`run` 新增 `--storage-state PRIVATE_FILE` 和 `--deployment-record PRIVATE_FILE`。
两个文件都必须位于工作区外，POSIX 下仅文件所有者可以访问。登录快照只允许声明目标域的 cookie 和 origin；
构建探针与每个独立 case 使用同一初始快照，cookie/localStorage 不进入 manifest。
部署记录格式为 `{ "version": 1, "commit": "...", "workspaceSha256": "...", "buildId": "..." }`。
部署时从源码指纹与本地产物字节生成记录，不能抄录远端探针返回值。托管的必需验收要求部署记录；独立 CLI 仍兼容旧文本探针。

Devflow 使用 `buildProbe` 的 `method: "POST"`、`format: "json"`、`path: "/devflow/api/build-info"`，
`field: ["value", "buildId"]`、`instanceField: ["value", "instanceId"]`，以及部署记录中的 expected。
运行前后均复核构建身份、服务实例与实际提供的客户端 bundle 字节；缺构建产物、构建变化或服务重启均不能通过。

宿主退出后，可用 `midscene_recover` 检查并清理中断的探索。恢复会验证进程归属，不重放浏览器操作；无法确认归属时仍标记不可用。

官方 CLI 探索期间宿主崩溃后，可在重启后调用当前会话工作区的 `midscene_recover`。
原宿主 PID 仍存活时拒绝恢复；否则核对私有进程记录，停止对应 CLI 命令、CDP 代理及自有 Chromium，不重放页面操作。
证据标记为 interrupted，不能确认所有权的资源保留 cleanup: unknown；借用 Chrome 不会被杀死。
Bridge 缺少可证明的进程所有权时保留 unknown，使用其正常断开流程。

本地 `glm-5.3-flash:cloud` 实测返回像素坐标，使用 `gpt-5` 协议适配通过了打开面板与视觉断言。`family` 选择的是 Midscene 协议与坐标约定，不能仅按品牌名称推断；这不表示该模型成为 GPT 或获得官方兼容认证。借用 CDP/Bridge 时请使用专用测试 Chrome 实例，CLI 可能导航该实例的当前标签页。

### 在认证沙箱中阅读 SDK 报告

发布的 SDK HTML 在界面启动前安装仅供当前文档使用的内存 `localStorage` 和 `sessionStorage`。因此报告能在 `sandbox allow-scripts` 下正常显示，无需授予 `allow-same-origin`、宿主 cookie 或宿主存储访问权。报告偏好仅保留到重新加载。正式报告发布为 `case-N.html`；探索报告复制到 `reports/`，SDK 原件不进入可提供的产物列表。HTTP 路由原样返回磁盘发布文件。测试在 Chromium 和实际 CSP 下打开真正 SDK 报告，验证断言正文可见、无页面错误，且宿主存储未改变。

## 登录准备与卡片报告

`devflow-workflow` 引导 Agent 复用现有 browser/acceptance Skill。Agent 自动发现环境，仅向用户询问缺失的测试角色、登录方式、测试数据和允许操作。SSO/MFA 由用户在专用浏览器中完成；账号密码不能写入对话、动作提示或卡片。

通过 `midscene_project` 记录非敏感的 `authentication: {required: true, role: "reader"}`，用 `midscene_auth` 导入授权的、项目外且仅所有者可读的 Playwright storageState 文件。快照按项目、目标源和角色隔离，正式运行和完成关卡都会复用。缺失或本地已过期的快照会阻止需要登录的项目运行；服务端撤销或错误角色需要先验证登录特征并重新准备，不能当成业务验收通过。

报告副本归档到卡片的 `artifacts/midscene/<runId>/`，包含 HTML 和已发布截图；私有运行目录和登录快照不进入项目。已有探索运行可通过 `midscene_archive` 指定卡片归档。报告可能含页面业务数据，应使用授权的测试数据。
