# DeepSeek Harness 的 devflow

[English](README.en.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的文件化开发状态管理：每项工作是一张**卡片**，卡片历史是一份只追加日志，每次阶段流转都提交到这份日志。十一个运行时插件围绕同一个 `ctx.devflow` 服务接口组合，另有一个声明式安装 bundle；Harness agent 是工作流执行者。

本仓库是一条独立的插件产品线，只依赖 npm 已发布的 Harness 包，不会修改 Harness。

## 包组成

| 包 | 作用 |
|---|---|
| `@zhchxiao123/dsh-devflow` | `ctx.devflow` 服务定义：卡片数据模型以及日志解码和回放 |
| `@zhchxiao123/dsh-devflow-filesystem` | 服务提供者：磁盘上的 `.devflow/`、`O_EXCL` 租约和按月归档 |
| `@zhchxiao123/dsh-devflow-gates` | 流转 waterfall 上的策略：按边执行命令，并支持一次性人工批准 |
| `@zhchxiao123/dsh-devflow-parent-gate` | 完成策略：拆分后的需求只有在全部子需求完成后才能进入 `done` |
| `@zhchxiao123/dsh-devflow-fs-guard` | 禁止 agent 的文件工具写入 `.devflow/`，确保状态存储是唯一写入路径 |
| `@zhchxiao123/dsh-devflow-artifact-gate` | 对已配置流转边执行确定性的产物契约检查 |
| `@zhchxiao123/dsh-devflow-agent-gate` | 对已登记产物执行独立的 LLM 准入检查 |
| `@zhchxiao123/dsh-devflow-tool` | 模型侧工具（`devflow_list`、`devflow_create`、`devflow_transition` 等） |
| `@zhchxiao123/dsh-devflow-command` | 确定性的 `/devflow` 人工干预入口 |
| `@zhchxiao123/dsh-devflow-web` | devflow 的浏览器通道：只读 JSON 路由和变更流 |
| `@zhchxiao123/dsh-devflow-ui` | 看板浏览器端：有 sidebar foundation 时显示侧边栏页面，否则显示浮动入口 |

卡片可以从三个相互独立的入口流转：模型使用工具，人工通过 `/devflow` 干预，批准请求走 Harness 的 approval 机制。Web 看板**只读**：路由只提供两种读取，没有任何写操作端点。

## Harness 版本

服务端组合仍按准确的预发布版本 `0.1.1-rc.2` 构建；看板客户端已适配 Harness `0.1.2-alpha.3` 拆分后的 `dsh-client-store`、`dsh-client-ui-renderer` 与 `dsh-client-ui-session` 边界，并完成本地 tarball 启动回归。依赖继续使用明确版本，不用浮动范围跨越 1.0 前的兼容性边界。

## 安装到 Harness

```sh
dsh plugin --profile web add @zhchxiao123/dsh-devflow-bundle
```

安装只需要这一条命令：`dsh plugin add` 将安装交给 pnpm，然后根据安装结果更新 profile 的 bundle 栈，因此 bundle 会自行挂载全部 devflow 配置项，无需编辑 profile 文件。看板也包含在内。可在 [`devflow-bundle`](packages/devflow-bundle/README.md) 中查看挂载内容、默认禁用项和覆盖方式。

## 实际运行效果

以下截图来自 DSH Web 中本仓库的真实回归会话，不是界面示意图。

### 工作区看板

![devflow 工作区看板，显示卡片阶段、修订号、阻塞状态和父子任务](docs/screenshots/devflow-board-overview.png)

看板汇总卡片数量和阶段，并直接显示 revision、阻塞状态以及父子任务。它是只读观察面；实际流转仍由 Harness agent 的 `devflow_*` 工具或人工命令完成。

### 卡片详情

点击卡片即可进入详情页，查看当前阶段、revision、完整阶段轨道、需求正文、验收标准、拆分关系和已登记产物。

![已完成卡片的详情页，显示当前阶段、revision、阶段轨道、需求和交付内容](docs/screenshots/devflow-card-detail.png)

### 阶段产物与流转时间线

![卡片详情中的阶段产物与流转时间线，显示五类文档、阶段变更、闸门结果和流转原因](docs/screenshots/devflow-card-timeline.png)

详情页汇总需求文档、设计文档、开发报告、评审报告和测试报告，并在同一时间线中记录产物登记、阶段变更、revision、发生时间、停留时长、流转原因和闸门结果，因此可以直接追溯卡片如何从需求草稿推进到已完成。

## 插件市场信息

**核心价值：**为 Harness agent 提供可持久化、可检查的开发工作流，包括文件化卡片、带 revision 校验的安全流转、可选的产物和准入检查、人工干预以及只读 Web 看板。

| 项目 | 支持情况 |
|---|---|
| 安装包 | `@zhchxiao123/dsh-devflow-bundle` |
| Profile | 完整 bundle 使用 `web`；服务端插件也可以单独组合 |
| Harness 兼容性 | Harness `0.1.2-alpha.3` 已完成本地启动回归；服务端包按 `0.1.1-rc.2` 合约构建；Cordis `4.0.1` |
| Node.js | `^22.19` 或 `>=24` |
| 本地数据 | 读写每个调用方工作区内的 `.devflow/`；状态存储不会修改项目源文件 |
| 网络与模型 | 不含遥测或内置第三方服务；可选的 agent 检查使用 Harness 已配置的模型提供方 |
| 命令 | 可选的命令检查只执行 profile 所有者显式配置的命令 |
| 默认设置 | 产物、agent、命令和批准检查已挂载，但在 profile 定义策略前保持禁用 |

安装入口是一个 `dsh.bundle` manifest，其 patch 负责挂载运行时包。函数插件按照 Harness loader 契约导出 `apply(ctx)`；服务包导出对应的服务类。

启用产物契约后，模型在尝试流转前就能看到产物要求。[真实 Loader 组合测试](packages/devflow-tool/tests/loader-composition.spec.ts)会断言如下形式的输出：

```text
Created card 0001-artifact-flow [draft] Artifact flow (rev 1).
artifact requirements for draft -> designing:
[missing] requirements-document

Card 0001-artifact-flow moved draft -> designing (rev 4).
artifact requirements for designing -> ready:
[missing] design-document
```

## 开始开发

```sh
git clone https://github.com/zhchxiao123/dsh-devflow-plugins.git
cd dsh-devflow-plugins
pnpm run init
```

`init` 按仓库记录的 lockfile 安装依赖，然后执行类型检查、lint 和测试；干净检出的仓库要么成功复现环境，要么明确暴露 Harness 依赖已经发生变化。之后可以运行：

```sh
pnpm run verify        # typecheck + lint + test, the pre-push gate
pnpm run test:coverage # per-file 100% on packages/*/src
pnpm run build         # emit lib/types
```

测试和类型检查通过 `tsconfig.base.json` 的 `paths` 在工作区包之间解析源码；使用方则通过 `exports` 解析构建后的 `lib/`。

## 开发记录

本仓库携带与代码同步演进的开发记录：

| 路径 | 内容 |
|---|---|
| `.agents/prd/` | 六份 PRD：每组改动的目标以及明确排除的范围 |
| `.scratch/devflow/` | 从 PRD 拆出的 22 个 issue 及各自的解决记录 |
| `.agents/notes/implemented/` | Agent Note：决策、备选方案及其理由 |
| `.agents/skills/` | 仓库工作方式：prose 规范、代码审查和 note 维护 |
| `docs/devflow.md` | 子系统说明 |
| `AGENTS.md` | 本插件产品线遵循的约定 |

从 `AGENTS.md` 开始阅读；首要规则是：**本插件产品线只依赖已发布的 Harness API。**

## 发布

十二个包始终以同一版本一起发布。详见 [RELEASING.md](RELEASING.md)；简化命令是 `pnpm run set-version <v> && pnpm run release`，只有类型检查、lint、测试、构建和 tarball 预检全部通过后才会发布。

## 测试

测试覆盖所有包，包括看板：`tests/loader-factory.ts` 通过模块表运行 Harness 已发布的客户端 bundle，使浏览器端测试使用真实的 `SlotRegistry` 而不是替身。`packages/*/src` 中每个文件都要求 100% 覆盖率，安装路径也会通过真实 Harness 启动进行验证。
