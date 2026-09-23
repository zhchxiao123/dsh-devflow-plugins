# JEV 自动辅助真实研发实验

日期：2026-09-23。结论边界：已实际运行 published Harness agent、真实 DeepSeek 和 TypeSafe/Jev，用户提示不包含 JEV；下列样本完成研发并通过独立跨进程验收，但八个自然样本均没有真实自动建议投递，不能据此宣称自动辅助提高了效率或质量。

## 路由、隔离与预算

- 执行器：独立 npm 安装的 Harness `0.1.5-rc.2`、Cordis `4.0.2`；采用 published `Context`、`agents.create`、`followup`、`whenIdle`，未 monkeypatch agent/provider。
- 开发模型实际路由：`deepseek-official / deepseek-flash`。判断实际响应模型：`jev-1.13.0`，TypeSafe SDK 锁文件固定依赖。
- 每个 arm 新进程重构建本工作区 `devflow/devflow-filesystem/jev/jev-typesafe/devflow-jev`。source SHA256、runtime lock SHA256、需求及初始代码 SHA256 保存于每次 `experiment.json`。最早 feature off 正式基线没有 sourceDigests 字段，需明确保留此证据缺口。
- agent 300 秒、每次模型响应 maxTokens 12000（非整项任务 token 上限）；自动辅助单次 15000 ms、每 turn 3 次调用、最多 1 次额外 steer、confidenceFloor 0.75。TypeSafe 20000 ms、retries 0，受更紧的 assistance abort 控制。
- 独立 Git fixture、独立 DSH_HOME、localhost 随机端口；只读现有凭据配置；没有修改用户 profile 或 3080 实例，没有复制凭据。
- 验收程序独立执行，每次 create/archive/list/restore 启动独立 Node 进程；固定脚本含 10 条显式断言。它不是盲测：部分 agent 读取并运行过该脚本；覆盖与读取边界详见文末日志复核。

## 固定需求/初始现场比较

| 场景 | 模式 | 总耗时 | Agent steps | 自动远端判断 | 自动投递 | 独立验收 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 新增归档/恢复，policy 1 | off | 37.758 s | 9 | 0 | 0 | PASS |
| 同上 | observe | 57.725 s | 10 | 3 | 0 | PASS |
| 同上 | assist | 81.550 s | 16 | 3 | 0 | PASS |
| 修复缓存归档重启丢失，policy 2 | off | 52.646 s | 9 | 0 | 0 | PASS |
| 同上 | observe | 96.635 s | 16 | 3 | 0 | PASS |
| 同上 | assist | 150.277 s | 28 | 3 | 0 | PASS |

每个场景/模式只有一次正式运行，模型无固定随机种子；表中的较慢耗时不能全部归因于自动辅助。结果只说明这批任务未观察到验收优势或时间收益。两组之间产品策略发生有记录的修正，不能混合成统计效果样本。策略 1 中辅助预算在完成前被耗尽；策略 2 已真实保留并执行 completion 判断。

自动判断数与本地记录数不同：policy 1 observe 有 7 条记录、assist 有 9 条，其中超额记录是本地 `budget-exhausted`，并未额外调用 Jev。旧 metrics.json 的 assistanceCalls 字段曾表示记录数，`results.json` / 本表已按带实际 model 的远端响应正确计算。新版 runner 将两者分列。

模型可能自主调用既有 `devflow_assess`（例如 repair assist），这是原有指引/工具行为，不能计作自动 assistance 的 delivered。汇总 `directJevToolCalls` 单独记录这些工具调用，不把它们隐去。普通工具错误计数不能直接等同无效重试或返工；真实日志保留，因果返工减少仍未知。

费用未知。DeepSeek token usage 保存在 metrics，TypeSafe 未返回的 token usage 保持 null，不能用调用次数、confidence 或 token 数代替实际费用及研发收益。

## 实际暴露并修正的问题

1. 中间步骤耗尽所有远端预算，最终交付前无法评审：已改为为 completion/repeated failure 保留最后一次。
2. 建议只有固定动作模板和文件名：policy 2 增加从真实要求/失败文本中选择的具体调查目标。
3. `node --test` 初始未识别为检查命令：已修正，并保留 exitCode 事实边界。
4. 后续动作缺少溯源及 provider/model 未进入幂等：已增加实际 callId/exit 信息，以及不含凭据值的 configuration identity。

这些是实现改进的依据，不应把迭代前实验当成最终实现已全部验证。新的诊断运行会在对应 `experiment.json` 标明源代码版本。

## 证据索引

- feature off：`runs/2026-09-23T08-54-01-822Z/off-metrics.json`
- feature observe：`runs/2026-09-23T08-55-38-397Z/observe-metrics.json`
- feature assist：`runs/2026-09-23T08-58-09-659Z/assist-metrics.json`
- repair off：`runs/2026-09-23T09-01-42-046Z/off-metrics.json`
- repair observe：`runs/2026-09-23T09-02-57-476Z/observe-metrics.json`
- repair assist：`runs/2026-09-23T09-04-47-280Z/assist-metrics.json`
- 汇总：`results.json`，可用 `node summarize.mjs` 重新生成。
- 复现方法：`README.md`；执行脚本：`run.mjs`；独立规格审阅：`spec-review.md`。

08:52:10 首次启动失败、08:52:40 off 冒烟、08:54:01 的中断 observe 均为准备记录，不计入正式三臂比较。

## 两个不强制投递的自然诊断样本

- 未提交归档草稿 repair-draft：107.634 s / 15 steps / 独立验收 PASS；三次真实判断全部 continue。planning 的 actionConfidence/justifiedProbability 为 0.79/0.73，changed-code 0.82/0.72，completion 0.46/0.28。并非单纯由动作选项分散造成门槛未通过，模型对干预必要性的支持也不足。
- 发布前审查 repair-review：137.485 s / 21 steps / 独立验收 PASS；三次全部 continue。planning 0.39/0.58，changed-code 0.51/0.59，completion 0.43/0.29。提示只要求审查是否可交付，未提前告诉持久化缺陷。
- 两个场景都使用真实未提交缓存归档草稿，使 planning 就能看到 diff。它们仅是 assist 诊断，没有相应 off/observe 对照，不纳入三臂效果统计。保持原门槛 0.75，未篡改判断或降阈值凑投递。至此停止自然样本搜索。

## 独立 Spec 核对

已核查建议不执行命令、不推进阶段、不绕过 validator；证据新鲜度、取消、预算、provider identity 与投递意图持久化均在当前 agent hooks 内处理。UI 区分投递与后续动作/检查，并明确不认定采纳或解决。具体性、completion 预算、node --test、结果溯源和模型身份幂等五个发现已由主实现修正。

剩余验收边界：这些真实自然样本没有 delivered，不能将 mocked hook 测试等同实际建议投递/采纳成立；clean checkout 初始 planning 没有相关实现源码；未知 dispatch/worktree 仅会话归属；浏览器操作、真实卡片 all-done 路径及父子 gate 验收不由本隔离实验覆盖。

复现脚本位于 [scripts/jev-assistance](../../scripts/jev-assistance/README.md)，只提交 driver、README 与 runtime 锁文件。Node syntax check 通过；仓库 oxlint 显式排除 .mjs，且产品 TypeScript 未启用 allowJs，所以这些独立实验脚本不是产品 typecheck/lint 覆盖的源码。原始完整现场保存在本地 .scratch/jev-assistance-e2e/runs，未提交 sessions 或大量 fixture。

## 受控重复失败运行契约（与自然样本分开）

运行 `2026-09-23T09-16-06-783Z` 完成：51.955 s、9 steps、3 次真实 Jev 判断、1 次真实投递，最终独立跨进程验收 PASS。published pre-step hook 在同一真实 AgentLoop turn 的第二边界，通过公开 ToolRuntime.execute 连续运行两次 `node --test store.test.mjs`，两个实际 exitCode 都为 1。没有 mocked 工具结果、私有 state 注入、替代 Harness executor、provider monkeypatch 或降阈值。实际失败输出也通过公开 hook 交给当前 agent。

- 两次受控调用：`controlled-failure-c5485608-4668-476b-a7dd-65e3f7b9c7b8`、`controlled-failure-e73590ef-8e93-4138-b5f1-6d8aaf0b53d0`。原始输出保存在该 run 的 assist-controlled-failures.json。
- 真实记录 `52f8d320-8666-43ab-8dc4-ce5f8995b601`：repeated-failure → read-evidence → delivered；actionConfidence 0.76、justifiedProbability 0.78，阈值仍 0.75，响应模型 jev-1.13.0。
- 实际持久化 session 日志 seq 17 含这条建议；当前 agent 后续 read（seq 19/21/23）、write（seq 49）、bash 验证（seq 54），不是实验脚本代替它修复。修改后的 archive/restore 调用 save 落盘。
- 记录后来为 check-passed，实际验证 callId `call_00_Y5l6zLq6dEj4rDAaoNFR8852`、exit 0。另一个类似建议(.78/.76)被一次 steer 预算限制，没有第二次投递。

这证明受控真实失败→自动观察→真实 Jev→当前 agent 收到建议→后续实际执行/检查的运行契约。当前 agent 同时收到了直接失败证据，不能把修复因果归功于建议；该受控例不计入八个自然样本，也不证明日常提速。八个自然样本仍全部零自动投递。

## 精确代码与依赖来源

下面保留每次实验的 SHA256（source-N 为对应四个产品源文件快照），最后一次另含五个实际执行 bundle 与 driver SHA256。整理后的复现 manifest 把 TypeSafe SDK 固定为 0.6.0，并将 overrides 收窄到实际 lock 中 52 个 DeepSeek/Cordis 包；已运行 npm ci --ignore-scripts 成功安装 82 个包。整理后的 lock SHA256 与原实验 lock 不同，原始实验文件/hash 未被改写。

<details>
<summary>完整 SHA256 provenance</summary>

```json
{
  "variants": {
    "source-0": null,
    "source-1": {
      "assistance.ts": "17b013c834f2d979319b987cab3e13a8bad68ed1fda797a1366951f1751f6a53",
      "assistance-policy.ts": "c899e2bc06ee1d6309f6d791466d656a8a01edea588ea99cf9e92b14cf14c7fd",
      "assistance-store.ts": "c10a03bb1dcc2895b80fc6f5dde4ef35f805471ff7ec460aa352c599575bdb1f",
      "workspace-evidence.ts": "66e52708b0a34bb3bce4f0560ffcd53632afc0ef772ad7e4b303cb8a8d5e43d9"
    },
    "source-2": {
      "assistance.ts": "e00efb8188a9434cec9e03618d99544416cb58b906d1d369cf6317ab62b7a73e",
      "assistance-policy.ts": "c899e2bc06ee1d6309f6d791466d656a8a01edea588ea99cf9e92b14cf14c7fd",
      "assistance-store.ts": "0452210b1c4ec728cf7c56f51f526e6ff584e75fbf438c4ae34f0bd60438ed88",
      "workspace-evidence.ts": "94595d43af3f09d2ef185cefd5cdb0d83d68f3ef23491b6970a4efb49e3d8365"
    },
    "source-3": {
      "assistance.ts": "616d22fee84933a31a982cc3cc63924b5b22378b1f7ca0b44087821f23a17678",
      "assistance-policy.ts": "77155a5cc53da9755a3029f1bdca8205f64ed13c1df74814bb0bdaa1a5612353",
      "assistance-store.ts": "0452210b1c4ec728cf7c56f51f526e6ff584e75fbf438c4ae34f0bd60438ed88",
      "workspace-evidence.ts": "94595d43af3f09d2ef185cefd5cdb0d83d68f3ef23491b6970a4efb49e3d8365"
    },
    "source-4": {
      "assistance.ts": "d4adc50609d98e758b99bb670fdd8573bbd6956fff1067315e4c2a61eefc6d96",
      "assistance-policy.ts": "77155a5cc53da9755a3029f1bdca8205f64ed13c1df74814bb0bdaa1a5612353",
      "assistance-store.ts": "0452210b1c4ec728cf7c56f51f526e6ff584e75fbf438c4ae34f0bd60438ed88",
      "workspace-evidence.ts": "94595d43af3f09d2ef185cefd5cdb0d83d68f3ef23491b6970a4efb49e3d8365"
    },
    "source-5": {
      "assistance.ts": "feca2b6d25eac0e76193de92c445cf37fb9e098eceed3bce7e86ac6a6def19f9",
      "assistance-policy.ts": "e2bb456ad42f0abc6f7e6a8f3375e82c1ba9bd42c84699e76643de06f274e8ed",
      "assistance-store.ts": "5f402132ef4eb3f8936d2be4a5811ee487872ff5dd047972ab2be45478274f52",
      "workspace-evidence.ts": "94595d43af3f09d2ef185cefd5cdb0d83d68f3ef23491b6970a4efb49e3d8365"
    }
  },
  "runProvenance": [
    {
      "run": "2026-09-23T08-54-01-822Z",
      "scenario": "feature",
      "sourceVariant": "source-0",
      "baselineDigest": "0fae04be7eac46433d3baf7735a97773f80e2ad384ae5af2819fe1b1e5902b7d",
      "runtimeLockDigest": null
    },
    {
      "run": "2026-09-23T08-55-38-397Z",
      "scenario": "feature",
      "sourceVariant": "source-1",
      "baselineDigest": "0fae04be7eac46433d3baf7735a97773f80e2ad384ae5af2819fe1b1e5902b7d",
      "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec"
    },
    {
      "run": "2026-09-23T08-58-09-659Z",
      "scenario": "feature",
      "sourceVariant": "source-2",
      "baselineDigest": "0fae04be7eac46433d3baf7735a97773f80e2ad384ae5af2819fe1b1e5902b7d",
      "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec"
    },
    {
      "run": "2026-09-23T09-01-42-046Z",
      "scenario": "repair",
      "sourceVariant": "source-3",
      "baselineDigest": "d2bf8be7e81bcd3663e90839f4fdccedcb87a61b9d6c831930609694db12db26",
      "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec"
    },
    {
      "run": "2026-09-23T09-02-57-476Z",
      "scenario": "repair",
      "sourceVariant": "source-3",
      "baselineDigest": "d2bf8be7e81bcd3663e90839f4fdccedcb87a61b9d6c831930609694db12db26",
      "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec"
    },
    {
      "run": "2026-09-23T09-04-47-280Z",
      "scenario": "repair",
      "sourceVariant": "source-4",
      "baselineDigest": "d2bf8be7e81bcd3663e90839f4fdccedcb87a61b9d6c831930609694db12db26",
      "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec"
    },
    {
      "run": "2026-09-23T09-08-01-229Z",
      "scenario": "repair-draft",
      "sourceVariant": "source-5",
      "baselineDigest": "d2bf8be7e81bcd3663e90839f4fdccedcb87a61b9d6c831930609694db12db26",
      "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec"
    },
    {
      "run": "2026-09-23T09-11-00-015Z",
      "scenario": "repair-review",
      "sourceVariant": "source-5",
      "baselineDigest": "d2bf8be7e81bcd3663e90839f4fdccedcb87a61b9d6c831930609694db12db26",
      "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec",
      "pluginBundleDigests": {
        "devflow": "73b958cce89dff2d2f9b01d3582ce75df035e842b8598481a110cbc481f314e6",
        "devflow-filesystem": "5862013d237138cc1d46757e802126c6d6d6db1560d23b28efc2bfede91f32f4",
        "jev": "3809a03398162e4f62b5ba3701f61a1c6979695e607b662a9b1f55de49f11e7a",
        "jev-typesafe": "fa1f243119e4fbcdce84e384dd69197cf280a7b63ce3c31e3fc26b006ba3156a",
        "devflow-jev": "25fd91a541a4c541c5557764d378d09cc2c3e327159c8fac6a84d4de97dc828a"
      }
    }
  ],
  "contract": {
    "run": "2026-09-23T09-16-06-783Z",
    "scenario": "contract-failure",
    "prompt": "请修复当前任务列表项目的失败测试，保持归档/恢复接口与持久化约定；调查实际失败原因、修改实现并重新验证。修改只限当前工作区，不安装依赖，不操作外部服务。",
    "sourceDigests": {
      "assistance.ts": "5dacabeb942e276e9811399202a3332b7a44c1a895b4058c858f4d69f703dc77",
      "assistance-policy.ts": "e2bb456ad42f0abc6f7e6a8f3375e82c1ba9bd42c84699e76643de06f274e8ed",
      "assistance-store.ts": "5f402132ef4eb3f8936d2be4a5811ee487872ff5dd047972ab2be45478274f52",
      "workspace-evidence.ts": "94595d43af3f09d2ef185cefd5cdb0d83d68f3ef23491b6970a4efb49e3d8365"
    },
    "pluginBundleDigests": {
      "devflow": "73b958cce89dff2d2f9b01d3582ce75df035e842b8598481a110cbc481f314e6",
      "devflow-filesystem": "5862013d237138cc1d46757e802126c6d6d6db1560d23b28efc2bfede91f32f4",
      "jev": "3809a03398162e4f62b5ba3701f61a1c6979695e607b662a9b1f55de49f11e7a",
      "jev-typesafe": "fa1f243119e4fbcdce84e384dd69197cf280a7b63ce3c31e3fc26b006ba3156a",
      "devflow-jev": "1367ca0807e4d51e7370eaa592902662a926039d92e4df7cf81596d1fb861a97"
    },
    "runtimeLockDigest": "b4331c20a12afd0858ddd87898d6ab678596e098879c5e66c1cd643e2467bbec",
    "budgets": {
      "agentTimeoutMs": 300000,
      "agentMaxOutputTokensPerResponse": 12000,
      "jevTimeoutMs": 15000,
      "jevCallsPerTurn": 3,
      "extraSteersPerTurn": 1
    },
    "baselineDigest": "f27068d0678f71889261bcd49f46214252102c3193cef927f193ac8a0f0a1feb",
    "harness": "0.1.5-rc.2 npm",
    "jev": "jev-1.13.0",
    "repeats": 1,
    "qualityMetric": "Independent process restart acceptance",
    "limitations": [
      "One task and one run per mode cannot establish efficacy.",
      "Actual provider token usage is recorded; currency cost is not inferred."
    ],
    "executedDriverSha256": "c4cb25ec4e1e00436731d3681d6954ff81ac4187896fe31fe532850293b0a83b"
  },
  "packagedRuntimeLockSha256": "cbb7ea7d4907aa35a8bacd61d11fac11a6da34d4b655b09e8fdec0ac37dd15f0"
}
```

</details>

## 最终工程验证

产品实现提交为 `b203491`，Git 证据采集取消后的进程清理修正为 `456b67c`，固定审查基线为 `9143cbc`。以上真实模型实验发生在实现迭代期间，具体执行版本以各自 provenance 为准；取消清理修正随后通过真实子进程回归测试，未把早期模型实验标为最终提交的重复验收。随后完成门禁补验包含下列全部工程检查与操作指标复算；相关代码和报告以本文件所属 Git 提交为准。

- 最终全仓 `verify` 和 `test:coverage` 均通过：243 个测试文件、3,104 个测试成功；全仓逐文件四项覆盖率均为 100%（statements 12,556/12,556，branches 9,213/9,213，functions 2,691/2,691，lines 10,165/10,165），覆盖率命令退出 0。
- 隔离执行基线 `9143cbc` 曾有 18 个文件未达覆盖率门槛，第一次交付尝试仍有 17 个。完成门禁拒绝仅解释基线缺口的做法；本次补齐真实 HTTP、文件系统、注册/卸载、取消/恢复和 UI 交互测试，并按已验证的同进程契约精简重复分支。没有降低阈值或新增覆盖率忽略标记，历史缺口现已清零。
- 新增 assistance runtime/config/policy/store、workspace-evidence 和 assistance-detail 组件覆盖率四项均为 100%。这不代表已穷尽运行环境或已经取得提效证据。
- `pnpm run typecheck`、`pnpm run lint`、最终 `pnpm run build` 和 `pnpm run preflight:tarballs` 通过，37 个包正常打包。实验脚本另行通过 `node --check`；独立锁文件通过 `npm ci --ignore-scripts`。
- 全仓回归包含既有合法阶段边、required-validator 和父子 gate 测试。自动辅助没有阶段转换权；这些回归与 Loader/hook 组合验证不等于逐条真实模型运行所有交付路径，也不等于 3080 浏览器验收。
- Standards 与 Spec 两项独立审查通过；补验发现并修正单项评估真实取消被误记为 unavailable 的问题。现在预先取消和在途取消均传播 JEV_ABORTED，不写不可用记录；provider 失败保留规范化错误，程序/存储异常原样传播。补验使用真实 engine/provider/AbortSignal，已删除伪造不可能 engine 返回的测试。

测试日志保存在本机 `/tmp/jev-assistance-verify-completion.log`、`/tmp/jev-assistance-coverage-completion.log`、`/tmp/jev-baseline-coverage.log`、`/tmp/jev-assistance-build-completion.log` 和 `/tmp/jev-assistance-preflight-completion.log`。完整模型实验现场仍在本工作区 `.scratch/jev-assistance-e2e/`，不随 Git 提交分发。

当前交付为代码、测试、使用说明和可复现实验；默认 `observe`。未推送、合并或安装到用户 `~/.dsh`，未重启 3080 服务。是否普遍让研发决策更快、交付更好，仍需更多真实需求对照；本报告不作该结论。

## 日志复核后的逐样本操作指标

这是对既有 8 个自然样本和 1 个受控样本的事后日志分析，没有新增模型调用，没有修改原始 session、fixture 或验收文件。指标定义是事后固定的操作口径，不是因果效果估计。

- **无修改同签名重复失败**：同工具及同业务实参的失败再次出现，期间没有成功的工作区源码/测试改写；bash 签名使用原始 command/workdir，不含 description。成功的同签名执行或源码/测试改写会清除前次失败。它是“无效重试”的窄代理，不把所有合法调查、不同命令重试或耗时操作称为无效。
- **后续改写轮次**：同一非隐藏工作区文件在首次成功 write/edit 的 agent step 之后，再次被成功改写的不同 step 数；一个 step 多次改写只算一轮。源码和测试都计入；`.devflow` 元数据、`/tmp` 验证脚本及故意替换旧实现再还原的命令不计入。它可以是修错、完善测试或扩充行为，不等于造成损失的返工。
- **失败后改写轮次**：当前实现/验证探针出现实际失败后、下一次成功验证前，成功改写源码/测试的不同 step 数。单独列出**无源码改写的验证命令修正**：失败验证之后，换了签名不同的验证命令且成功，期间没有源码/测试改写。
- **失败证据**同时读取真实 tool-result 的 isError、bash 末尾退出码，以及验证输出中明确的 Node 测试失败/未处理异常。因此 `node --test | tail` 之类把进程退出码掩盖成 0 的失败不会漏算。主动针对 HEAD/old-store 旧实现运行的反向验证独立记录，排除出当前实现失败与返工统计。没有对应 call/result 或日志缺失时脚本报错，不填 0。
- **误干预**逐条复核已投递建议。本轮唯一建议有两次真实失败依据，建议内容与修复任务一致，只建议读证据，实际投递一次且未超预算，当前 agent 继续执行，最终独立验收通过，未发现该判定范围内的错误干预。是否多余、是否必要以及修复是否因其发生不能从此推断。后续未经复核的新记录返回 unknown，不自动归为无误干预。无投递时次数是 0，率是 N/A。

表中“断言”表示下文固定验收程序的显式断言通过数，并非全部业务需求覆盖率。受控行的重复失败由公开 hook 刻意执行两次造成，不计作模型自然产生的无效重试。

| 场景 / 模式 / UTC时刻 | 秒 | 无改重复失败 | 后续改写轮次 | 失败后改写轮次 | 验证命令修正 | 显式断言 | 误干预次数 / 率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| feature / off / 08-54-01-822 | 37.758 | 0 | 0 | 0 | 0 | 10/10 | 0 / N/A（零投递） |
| feature / observe / 08-55-38-397 | 57.725 | 0 | 0 | 0 | 0 | 10/10 | 0 / N/A（零投递） |
| feature / assist / 08-58-09-659 | 81.550 | 0 | 1 | 1 | 0 | 10/10 | 0 / N/A（零投递） |
| repair / off / 09-01-42-046 | 52.646 | 0 | 0 | 0 | 0 | 10/10 | 0 / N/A（零投递） |
| repair / observe / 09-02-57-476 | 96.635 | 0 | 1 | 1 | 0 | 10/10 | 0 / N/A（零投递） |
| repair / assist / 09-04-47-280 | 150.277 | 0 | 2 | 0 | 1 | 10/10 | 0 / N/A（零投递） |
| repair-draft / assist / 09-08-01-229 | 107.634 | 0 | 0 | 0 | 0 | 10/10 | 0 / N/A（零投递） |
| repair-review / assist / 09-11-00-015 | 137.485 | 0 | 4 | 0 | 1 | 10/10 | 0 / N/A（零投递） |
| 受控失败 / assist / 09-16-06-783 | 51.955 | 1（注入） | 0 | 1 | 0 | 10/10 | 0 / 0/1（仅限上述判定） |

### 可回查的序列位置

下列 seq 是该样本真实 session.v3.jsonl.zstd 中 tool/call 的序号。受控两次执行没有伪造 session 工具事件，证据来自 controlled-failures.json 和公开 hook 消息；汇总将它们的 seq 保留为 null，仅按消息边界排序。results.json 保留每次 callId、签名 SHA256、失败分类、文件路径和对应结果 seq。

| 样本时刻 / 模式 | 当前验证失败 seq | 源码/测试改写 seq | 排除的旧实现反向验证 seq |
| --- | --- | --- | --- |
| 08-54-01-822 / off | 无 | 38, 43 | 无 |
| 08-55-38-397 / observe | 无 | 36, 41 | 无 |
| 08-58-09-659 / assist | 66 | 56, 61, 71 | 无 |
| 09-01-42-046 / off | 无 | 33, 35 | 45, 50 |
| 09-02-57-476 / observe | 47 | 37, 42, 52, 54 | 64 |
| 09-04-47-280 / assist | 82 | 60, 62, 72, 92, 97 | 107, 112 |
| 09-08-01-229 / assist | 无 | 55, 60 | 70 |
| 09-11-00-015 / assist | 40 | 50, 65, 70, 80, 85, 100 | 无 |
| 09-16-06-783 / assist | 39；另两次真实注入失败 | 49 | 无 |

具体例子：feature-assist 的 seq66 测试失败后，seq71 修改测试、seq76 重测成功，计 1 轮；repair-observe 的 seq47 失败后，seq52/54 在同一个 step 修改测试，计 1 轮。repair-assist 的 seq82 与 review 的 seq40 是临时验证脚本相对 import 路径错误，分别在 seq87/45 换验证命令成功；没有期间源码改写，故单列为验证命令修正，而不是把源码返工记成 1。review 有 4 轮后续改写，但不能凭其时间顺序认定这 4 轮都在修错。受控测试的实际错误为 `TypeError: store.archive is not a function`，重复失败触发成立；最初并未执行到其持久化断言。

### 验收覆盖及非盲测边界更正

全部 9 个正式/受控运行的 acceptance.mjs SHA256 均为 `9e73741aac0c4494cd7308b4aff21f116451392b8d0c498c835b56b00e76a8e7`，与 driver 的固定验收字符串逐字相同，未发现被 agent 改写。每次验收均由 driver 独立启动进程执行并成功退出；各 create/archive/list/restore 操作再启动独立 Node 进程。10 条显式断言分别是：归档后新进程默认列表为空（1）；includeArchived 的数量、id、title（3）；恢复后新进程的数量、id、title（3）；重复恢复后数量仍为 1（1）；archive/restore 对 missing-id 各返回非空错误信息（2）。

覆盖局限不能省略：重复 archive 虽被再次调用且未抛错，但没有紧随第二次 archive 的状态断言；错误检查仅证明消息非空，未自动证明语义“清晰”。所以 10/10 不是全部业务需求 100% 覆盖。

实验**不是盲测，也没有硬文件沙箱**。feature-off 的 seq31/33、受控样本的 seq30/32 实际读取了工作区外的 acceptance.mjs/experiment.json；它们还自行运行过该验收。其它样本同样具有读取能力。原来的“验收位于工作区之外”仅描述文件位置与独立执行，不意味着 agent 看不到、不能读取或面对未知测试集。这削弱质量泛化结论，但不改变这份固定验收的独立进程执行和文件完整性事实。

### 离线复算与原始证据摘要

运行 `node scripts/jev-assistance/summarize.mjs .scratch/jev-assistance-e2e` 即可复算；脚本只读 session/fixture/指标文件，仅更新该证据目录的 results.json。它解码所有串接 Zstandard frame，并核对完整 tool/call→tool/result 配对；未调用任何模型。原始 session 文件的 SHA256 如下：

| 样本时刻 / 模式 | session SHA256 |
| --- | --- |
| 08-54-01-822 / off | `9ce4017b51f2f8acb990b16093972b7f2dd1e648c3954b60d121edb8e787bef2` |
| 08-55-38-397 / observe | `15a0b5acfa02f55a3a090381a1984f8b247b1e982f1da1db0a9004263bd5a32e` |
| 08-58-09-659 / assist | `73b977daaefd98bd72d186c949951649163fa12ee2740d3e322d8d993c974202` |
| 09-01-42-046 / off | `b007ef0c18f2e798019fe81be9ab1871f70d8d40c6adf7c60a9411dbd94d5219` |
| 09-02-57-476 / observe | `5a8273647318bc9d55a1b0cbd0761bd487931964defe1bb0a3ea820750c85101` |
| 09-04-47-280 / assist | `286a9a41bf5ae5fdf82c5bf1bca598d86ce3a42007c80463213d84df2a765fa6` |
| 09-08-01-229 / assist | `8dee4e0b05db36179cdeddd4e715b0c5bf2b922758e8e28e044edafc8bfd6712` |
| 09-11-00-015 / assist | `9fcafa0c4dce30f29f0bf28e6cf8c4488dfb31d12290372ab62b322dba3efb67` |
| 09-16-06-783 / assist | `ef4939d51d8f41c37ca4f12b67c610a6b80c87d19e6e9f07ff26deb46716ae2e` |

这些可观察指标补齐了耗时、重复失败、后续改写、失败后修正、验收断言和已投递建议审查；因果返工减少与提效仍未得到证明。8 个自然样本零投递，不能从它们的零误干预次数推断有效率或安全率。
