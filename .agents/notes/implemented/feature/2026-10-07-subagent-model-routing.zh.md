# Agent Note: Subagent model routing by typed judgement

Status: implemented

## Problem

派发出去的子 agent 跑在派发时指定的那个模型上，而没有任何环节检查这个尺寸对不对。同一个缺口导出三种后果：一次机械查找占用了部署里最贵的模型；一个跨层设计任务被交给最便宜的那个；而在最常见的情形下——派发根本没指定路由——子 agent 静默继承父路由，那是为父对话选的路由，不是为这个被派发的任务选的。

harness 本身已经有逐次派发设路由的机制。`@deepseek-ai/dsh-tool-subagent` 开 `modelSelectionSettings: true` 后会在派发调用上暴露 `provider`、`model`、`reasoning_effort`，并注册 `list_subagent_models`。缺的是决策者：今天的决策者是派发方模型的无依据猜测，驱动它的只是 prompt 里恰好写了什么。

## Decision

新增一个 `ctx.jev` 的 Consumer —— `@zhchxiao123/dsh-jev-model-router` —— 由 typed judgement 做决策，并纠正不一致的选择。

**一份有序档位表就是全部配置面**，因为它同时是三件事：判断评分的 rubric（`criteria[i] = tiers[i].when`）、guidance 让模型从中选择的表、以及把档位换回路由的映射。单独再配一张阈值表，就等于给同一个序关系写了第四份描述，而它随时可以与另外三份不一致。分数是概率加权的、可能落在两档之间；`Math.round` 把正中间的值送到**更强**那档，因为配弱了的代价是结果错、配强了的代价是钱，这两者不是同一种错误。

**guidance 是主机制，纠正是例外。** 每次组装的 prompt 都带上档位表和「每次派发都要设路由」这条指示，于是选对的模型永远不会被打断。判断发生在 `tools/pre-execute`——那里能拿到真实的派发 prompt 作证据——与判断不一致的选择会被驳回一次，理由里点名档位、其确切路由、以及该档覆盖的场景。

**只驳回一次，且以 prompt 为键。** 纠正后的派发是一次新调用、新 `callId`，所以账本以派发 prompt 的摘要为键，存在按 agent 划分的 `WeakMap` 里。对同一 prompt 的第二次拒绝会把路由偏好变成一个死掉的派发，所以第二次尝试无论选了什么都放行。

**没有凭据就让 gate 停摆、留下 guidance。** `ctx.jev.configurationStatus()` 只报告本地配置。当它不是 `configured` 时，不做判断、不拒绝任何派发：同一个决策，由模型来做，依据的是判断本会使用的同一批档位描述。因此降级模式不是另一条代码路径，而是某条路径的缺席。

**空转的路由器要出声。** `list_subagent_models` 不存在时，没有任何字段可供纠正去要求模型填写，而本包无法自己启用一个——那是另一个插件的 load-time 配置，采样进 session 后即固定。它每次加载 warn 一次并点名部署缺了什么，而不是让 mount 失败、也不是静默什么都不做。

### 为什么是驳回纠正，而不是注入路由

两条可用的 seam 都无法绕过模型设置路由，而正是这个事实塑造了整个设计。

`tools/pre-execute` 不能改写入参：`ToolExecution.arguments` 是 readonly，`PreToolDecision` 只有 allow/deny/ask，并且排除的理由就写在它自己的文档注释里——监听器运行时入参已经被记录和呈现过了。运行期改子 agent 路由的路也都封死了：`AgentRuntime.options` 是 readonly，`agent/pre-step` 只决定 enter/reject，而 `ctx.agentDefaultModel.save()` 是全局可变状态，会与并发创建竞态。

subagent provider 装饰器能设 `agentOptions`，对 one-shot start 是可行的——service 在调用 provider 之前只把 `mode`/`provider`/`label` 解析进 descriptor，而 in-process driver 允许 `request.agentOptions` 覆盖父路由。但 `backgroundMode: continuable` 把 `run_in_background` 默认成 true，该路径经 continuation manager 创建子 agent，而后者只会问 provider 要不要用父历史做种子。三套出厂 preset 都把启用了模型选择的 `subagent` 工具挂成 `continuable`，所以装饰器只能覆盖显式前台的少数派发。

## Alternatives considered

**subagent provider 装饰器。** 注册一个包住真 provider 的 provider，在调用方没指定路由时填 `agentOptions`。硬保证、零重试、对模型不可见。作为 MVP 被否决，因为它漏掉所有 `continuable` 派发，而出厂 preset 正是把派发放在那里；部署方得把 `subagent` 工具改成 `backgroundMode: one-shot`、放弃 continuable 子 agent 才能让它生效，这是用一个真实能力去换一个路由偏好。它后续仍可增量加上——档位表与判断形状都不用改——而值得加它的条件是：某个部署需要在模型选择关闭的情况下路由，或者要求前台路径零重试的确定性。

**装饰器与纠正都做。** 全覆盖，外加前台路径的硬保证。MVP 阶段被否决，因为这会产生两个可能对同一次派发意见相左的决策点，并让读者需要同时持有的失败模式翻倍。

**用 `Choice` 在路由名之间选，而不是用 `Score` 在档位之间评分。** 被否决：那会把部署方的路由名写进判断本身，换一条模型线就得重写问题描述。用 Score，路由是代码查表的数据，rubric 保持在描述工作本身。

**配置一个 `defaultTier`，在判断不可用时套用。** 规划阶段带着它，实现阶段删掉了：既然没有注入点，「套用某档」只能意味着「朝它驳回」，而因为判断失败就驳回，与「路由永不阻断派发」这条规则相矛盾。这个字段没有一个说得通的消费者，所以它不存在。

**把包命名为 `devflow-model-router`。** 被否决：它不碰 card、transition、attempt root，`devflow-` 前缀会宣称一个它并不具备的依赖。它与 `jev`、`jev-typesafe`、`jev-triage` 同列，是该 seam 的又一个 Consumer。

**让 `scoreInstruction` 可配置。** 暂不采用：档位已经承载了随部署变化的那部分，目前没有消费者需要重新定义「需要多少能力」的含义。以后要加也就是一个字段的成本。

## Consequences

**路由是建议性的，不是强制的。** 模型可能两次都选错，第二次会放行。在 harness 当前的 seam 下，没有任何机制既覆盖完整又是硬的，README 把这点写明，而不是暗示一个保证。

**每次受管派发多一次判断往返**，由 `judgeTimeoutMs`（默认 2500）用自己的 `AbortController` 兜住，而不是用 provider 那个共用的 20 秒超时。两种 abort 的原因被刻意区分开：调用方的撤回返回 `withdrawn`，交由注册表自己的取消复查把中断报告为中断；而本路由器的 deadline 算判断不可用。这个原因以 symbol 的形式挂在 abort 上传递，而不是从错误里读——因为所有 provider 都把两者报告为 `JEV_ABORTED`。

**两档不得共用一条路由**，mount 期即拒绝：点名任一档的纠正都无法从派发自身的字段中核实。

**不校验 `reasoningEffort`。** 一个档位由 `provider` 与 `model` 标识；路由正确但 effort 不同的派发不会被纠正。effort 随 guidance 和纠正文案一并给出。

**一条代码无法强制的部署约束。** 档位路由不得同时出现在派发工具的 `agentOptions` 里，因为那个字段正是模型什么都没填时工具会发出的值——两处都填会让「模型选了」和「配置填了」无法区分。README 承载这条；违反它不会导致任何失败，只是路由器从此分不清一次派发是需要路由还是已经路由过了。

**进 bundle 但默认 disabled。** 档位表没有诚实的默认值——那些路由是某个部署自己的模型 id——所以 `devflow-bundle` 里这一行带 `disabled: true` 并写明原因，与 `devflow-review-gate` 等其他按需启用的闸门一致。

## Testing

`tests/gate.spec.ts` 让派发经过真实的工具注册表，于是一次拒绝是作为模型可见的错误被观察到的，一次放行是作为工具体真的运行了被观察到的。纠正预算在它可观察的地方被测试：同一 prompt 被驳回一次然后放行、同一 agent 的另一个 prompt 仍被纠正、以及上限触发时淘汰最早的那条。

`tests/judge.spec.ts` 用真实的 `AbortSignal` 而不是 mock 抛异常来区分两种 abort，因为被 mock 的取消分不清是哪个信号触发的。

`tests/guidance.spec.ts` 直接断言第一次组装，从不安排一个先于它的 pre-step：已发布的运行时在那条 waterfall 之前就组装 prompt context，所以依赖另一种顺序的 spec 对第一次模型请求什么都证明不了。

`tests/loader-composition.spec.ts` 用真 Loader 启一份把档位表写成 YAML 的 `cordis.yml`，然后拒绝一次派发并让重试通过——单元测试看不到的两种失败是：真实注册表没有把拒绝物化出来，以及真实的 system-prompt 服务从不要求本包填那个 ordered context。
