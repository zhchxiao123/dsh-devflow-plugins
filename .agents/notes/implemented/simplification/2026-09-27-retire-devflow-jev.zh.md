# Agent Note: 退役 devflow-jev 与 devflow-jev-gate —— 保留 seam，删掉停摆的消费者

Status: implemented

## Problem

jev 一共发了五个包，其中最大的两个 —— `devflow-jev`（`src` 2740 行）与 `devflow-jev-gate`（408 行）—— 从未改变过任何一次会话的行为。自动辅助默认 `observe`，只记录判断、不投递任何一条；每条 gate 边默认 `warn`，只记录裁决、永不否决；而这条 plugin line 里没有任何组合挂载 `ctx.jev` 的 Provider，于是两行都停在一个无人应答的 seam 后面。

影子模式是刻意的 —— warn 记录正是"把否决权交给模型之前必须先有"的校准数据 —— 但没有任何东西闭合那个本该结束影子模式的回路。`jev-triage` 按设计不留跨会话记录，而校准导出在标注行数不足 100 时拒绝汇总，一个什么都不记录的部署永远到不了这个数。为等待度量而停摆、却又没有通往度量的路径的产品面，只会一直停摆，同时仍要随每次 harness 升级一起搬迁。

## Decision

删除 `packages/devflow-jev` 与 `packages/devflow-jev-gate`，以及只服务于它们的工具：`scripts/jev-assistance/`、`scripts/jev-calibration.ts`、`tests/jev-calibration.spec.ts`。`devflow-bundle` 去掉 `devflow-jev` 那一行与对应依赖；`jev-runs` 保留，因此领域中立的持久化 run 及其工具不受影响。

seam 仍然保有约定要求的三个角色：`jev` 是 Service Definition，`jev-typesafe` 是 Service Provider，`jev-triage` 是 Consumer。`jev-triage` 值得留下，一是它的规则不会付出昂贵代价 —— 只有当某文件评分低于 `skipBelow` **且**判断置信度达到 `confidenceFloor` 时才会被跳过，最坏情况只是白读了一个文件 —— 二是它的收益落在一次 code review 之内，而不是摊在一个季度的流转日志里。

`.agents/notes/` 与 `docs/reports/` 中关于这些已退役工作的记录原地保留。它们陈述的是当时确实做过的决策，删掉它们是在删历史，而不是删代码。

## Alternatives considered

- **把 `devflow-jev` 砍到只剩 `devflow_assess`。** 那会为了暴露一个当前没有任何组合调用的工具，保留评估存储、web 传输、侧边栏和整套 rubric —— 也就是 2740 行里的绝大部分。
- **反过来把默认值打开**（`assistance.mode: assist`、enforce 边）。这会在准确率从未针对本仓库度量过的判断上，给模型一份阶段流转的话语权。校准数据必须先存在，而 `jev-triage` 采集它的代价更低。
- **留着包但不挂载。** 这正是它们现在的状态。成本从来不在挂载，而在 3148 行 `src` 及其测试、双语文档配对和覆盖率义务要随每次 harness 升级一起搬迁。

## Consequences

Judgements 侧边栏、项目审计、请求与卡片评估、以及记录判断的流转都随之消失；需要它们的部署可从 git 历史恢复 —— 在执行删除的那个提交上，这些代码仍然可达且通过类型检查。类型化判断这项能力本身完好且可组合，`jev-triage` 现在是它全部的消费者面。

这笔交换换来的是：剩下的每一行 jev 代码都有调用者 —— Definition 有 Provider，Provider 有 Consumer，而 Consumer 的效果在它所缩短的那次 review 里可被观察。原本要用来给已退役那几行做辩护的度量，如今变成了更便宜的事，落在唯一存活的消费者身上。
