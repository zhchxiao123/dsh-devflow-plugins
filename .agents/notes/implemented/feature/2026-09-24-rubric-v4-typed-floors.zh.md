# Agent Note: Rubric v4 —— 时序事实交给代码，阈值按答案类型分离

Status: implemented

## Problem

Rubric v3 有三处对判断模型公开指引的系统性偏差。`testEvidenceFresh` 让模型回答 journal 本可直接回答的版本比较问题，而这恰是模型的已记录弱项。intake 门控对全部答案求伪置信均值——从 Noul 推导 |p−0.5|×2、与 Choice/Score 的分布置信混在一起，还让 `serviceClass` 偏好题的概率分散把可自动化的评估推去人工复核。阶段 rubric 的 Noul 没有对照式 criteria，是/否边界留给了模型。

## Decision

Rubric v4。freshness 问题移除：`evidence.ts` 从 journal 事实计算"test-report 工件登记不早于当前阶段修订"，`evidenceState` 把它作为观察事实交给模型，审计聚合自己对 test-impact 与 release-readiness 评估产出确定性的 `test-evidence-stale` 警告。被证据预算截断的 journal 只会产生假"过期"，绝不会产生假"新鲜"。

置信阈值按其读取的量表分离：`choiceConfidenceFloor` 与 `scoreConfidenceFloor` 取代共享的 `confidenceFloor`，Noul 只按概率过阈，任何阈值都不再跨类型使用。每条决策路径只检查它消费的答案；`serviceClass` 位于一切门控与记录置信之外，记录置信改为所消费 Choice/Score 答案的分布集中度最小值（评估不完整为 0，仅有 Noul 时为 1）。全部阶段 Noul 补上对照式 true/false criteria。策略覆盖命名未知字段——包括已退役的 `confidenceFloor`——在启动时报错，而不是静默不生效。

## Alternatives considered

- 保留派生的 Noul 置信并给它独立阈值：否决——这个派生正是失败模式文档所指的跨量表复用。
- 给每个阶段 Noul 单独的概率阈值：暂缓；`informationFloor` 兼作通用 yes 阈值是已知的粗粒度，等校准导出给出依据后再细化。
- 对所有评估类别产出 stale 警告：否决——只有 test-impact 与 release-readiness 消费测试证据，其余场景是噪音。

## Consequences

RUBRIC_VERSION 为 4；审计 check 身份携带版本，既有 run 与记录保持可读，跨版本比较保持诚实。覆盖 `policy.confidenceFloor` 的部署会在启动时报错，必须明确选择所指的类型化阈值。判断门不受影响：其否决条件读取稳定的答案 id。阈值数值本身在校准导出（#38）给出分类型证据之前仍是手设的。
