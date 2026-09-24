# Agent Note: 判断门作为 Jev 唯一的执法席位

Status: implemented

## Problem

判断层（assess、audit、assistance）已经完整，但执法路径没有任何环节消费它：准入与评审 gate 仍运行全价 checker 子代理，判断结果只经评审面板到达人工。早先的计划把判断一次接进多个点——agent-gate 影子、review-gate 分流、assistance 触发器、判断缓存（issue #35/#36/#40–#48）。评审发现落点散在三种机制上、整体难以解释；而 devflow 架构本就只有一个策略平面：流转瀑布。

## Decision

新增唯一的 gate 包 `devflow-jev-gate`，是 Jev 判断获得执法效力的唯一位置。它是纯 Consumer：`ctx.devflowJev.assess` 提供 rubric、证据与持久化的评估记录；gate 把判断绑定到配置的 `from->to` 边上，把每个评估写成流转 journal 中的一行 `GateCheck`，并写明评估记录 id，使答案与后续的人工 accept/reject 都可从 journal 追溯。

每条边两种模式，以及给它们排序的模块规则：**判断只能失去发言权，绝不能获得未被授予的否决权**。`warn` 只记录、永远放行——warn 记录就是在授予模型否决权之前必须先存在的校准数据。`enforce` 仅在封闭且显式配置的条件集（发布 blocked 概率质量；高且够置信的风险分）上否决，在否决理由里写明触发数字，判断不可用时按该边显式的 `failClosed` 选择处理。低置信的高风险分永远不否决：不确定是警告，不是拦截。判断只在下游策略放行之后运行，被其他 gate 拒绝的移动不消耗判断。

配置在加载时即报错：未知阶段、未知评估类别、warn 边上的 enforce 字段、缺少对应评估的条件，都是启动失败。

## Alternatives considered

- 多点接入计划（#35）：第一天覆盖更广，但三种消费机制、三个配置面，且每步影子要攒的校准数据，warn 模式在流转粒度上免费产出。
- 直接调 `ctx.jev` 并自带 rubric：换来对 devflow-jev 的独立，代价是要维护第二份 rubric 的诚实性；为复用唯一 rubric 与其评估存储而否决。
- 做成 `devflow-gates` 的 required-validator：validator 是机械的仓库命令，有自己的注册语义；判断不是命令，warn 模式在那里没有位置。
- 只发 warn：被否决，因为 enforce 契约（封闭条件、显式 failClosed、理由带数字）正是需要在数据到来之前设计好的部分，即使每个部署都从 warn 起步。

## Consequences

该 gate 不新增缝、存储或模型工具。其记录寄生于 journal（`gate.checks`）与既有评估存储；校准导出（#38）同时读取两者。判断延迟只落在配置的流转上，受每边 deadline 约束。rubric 目前按 v3 的每类别问题集作答；#37（rubric v4）改问题措辞与代码化事实而不动本 gate 契约，因为条件读取的是稳定的答案 id（`releaseDecision`、`changeRisk`）。生产开启以 #39（代理连通实证）为前提。
