---
title: 'devflow-jev-gate: 流转边上的 Jev 判断门（warn 先行，enforce 按边升级）'
labels: [kind/feature, ready-for-agent]
date: 2026-09-23
issue: https://github.com/zhchxiao123/dsh-devflow-plugins/issues/49
---

# PRD — devflow-jev-gate：Jev 在 devflow 的唯一执法落点

> 本文件取代同名早期草案（"执法路径接入"多点方案，原 issue #35，已关闭）。
> 收敛理由：devflow 的架构中心是 transition waterfall 上的 gate；Jev 作为一种
> 新 gate 类型落在这里，是唯一不增加新机制的接法。多点接入（agent-gate 影子、
> review-gate 分流、assistance 触发器、缓存）已整体搁置，见 #35 关闭说明。

## Problem Statement

devflow 的 jev 判断层（assess / audit / assistance）已经建成，但没有一个执法点消费
这些判断：判断结果走人工评审面板，流转的把关仍完全依赖 checker 子代理与确定性
脚本。同时判断层自身的使用面（三条产品线、各自的配置与记录）已经复杂到难以向
使用者解释"Jev 到底在我的流程里干什么"。需要一个单一、可解释、风险可控的落点。

## Solution

新增 gate 包 `devflow-jev-gate`，注册在 transition waterfall 上，与
agent-gate / artifact-gate / review-gate / parent-gate 并列。契约一句话：**在配置的
流转边上，用该阶段的 rubric 问一次 Jev，代码按阈值裁决；默认只警告，不否决。**

- 触发点：卡片流转。每张卡一生只有几次流转，调用频率与成本天然低。
- 问什么：复用既有 stage→assessmentKind 映射与 rubric（#37 修订后的版本），
  不发明新问题集。
- 边级模式：`warn`（默认）——判决、概率分布与证据摘要写 journal，finding 附卡，
  放行；`enforce`——仅对该边显式配置的条件否决。所有边先跑 warn；升 enforce 的
  唯一依据是 #38 从 warn 记录导出的一致率数据。
- 确定性事实优先：可由 journal/artifact 机械算出的事实由代码写入 state，模型只答
  语义问题（#37 的 testEvidenceFresh 代码化是先例）。
- 失败安全：Jev 不可用时 warn 记录 unavailable 后放行；enforce 按边配置
  fail-open/closed。waterfall listener 照常 next() 委托，不改 devflow-gates 契约。

配套三件事（独立 issue）：#39 连通性实证（生产开启前提）、#37 rubric v4
（问题修对）、#38 校准导出（warn 记录 + 人工裁决 → 置信-准确率分组，enforce 的
升级依据）。

## User Stories

1. 作为流程管理者，我想在指定流转边上配置 Jev 判断门，以便语义级把关有一个统一、可解释的落点。
2. 作为流程管理者，我想让所有边默认只警告不否决，以便在校准数据积累之前判断错误的代价只是一条多余的 finding。
3. 作为开发者，我想在流转时看到判决、概率与依据写入 journal，以便每次把关事后可以按当时的数字复盘。
4. 作为流程管理者，我想仅在数据支撑后把个别边升级为 enforce，以便否决权的每次授予都有一致率依据、可回滚。
5. 作为开发者，我想让可机械计算的事实由代码算出而不是问模型，以便判断可复现且不踩模型已知弱项。
6. 作为依赖门禁的用户，我想让 Jev 不可用时 warn 边照常放行、enforce 边按配置失败，以便判断服务抖动不阻塞交付也不静默放水。
7. 作为流程管理者，我想让未配置该 gate 的项目流转行为与现状完全一致，以便渐进采纳。
8. 作为项目负责人，我想让 warn 记录自动成为校准数据源，以便不需要独立的影子机制。
9. 作为插件开发者，我想让该 gate 走既有 gate 注册与 Config 校验惯例，以便它是"又一个 gate"而非新机制。
10. 作为安全负责人，我想让发往判断 API 的证据复用既有脱敏与字节上限管道，以便新落点不扩大数据面。

## Implementation Decisions

- 独立包 `devflow-jev-gate`，注入 `devflow` 与 `jev`；不新增 capability seam。
- 边配置（源阶段→目标阶段、模式、阈值、fail 策略）为经 schema 校验的 Config 字段；无硬编码可调参数。
- rubric 与证据收集从 devflow-jev 复用；若需导出面调整，属 devflow-jev 的显式导出变更而非复制实现。
- 判决记录的持久化走 journal 追加（devflow 的状态提交点），finding 为投影。
- enforce 的否决理由必须包含触发条件与具体判决数字。

## Testing Decisions

- 假 provider 打在 `ctx.jev`，按脚本返回答案/缺席/分类错误；断言流转结果、journal 记录与 finding，不断言内部序列。
- 组合测试经真实 Loader：未配置时行为与现状一致；warn 边全场景放行；enforce 边仅配置条件否决。
- 先例：devflow-parent-gate / agent-gate 的 gate 测试、devflow-jev 的 loader-composition 测试。
- 维持 `packages/*/src` 每文件 100% 覆盖。

## Out of Scope

- assistance 线的任何投入（#36/#43/#45 已搁置）；review-gate 分流（#40）；判断缓存（#41）；agent-gate 影子（#46/#48）；完工对账独立机制（#42/#47，由本 gate 在流转时点覆盖）。
- 阈值自动调参；模型升级与重新校准流程。

## Further Notes

- 存续 issue 图：#49（本 gate）← #37（rubric v4）、#39（连通性）；#38（校准导出）读 #49 的 warn 记录。#34 收窄为 #37 + 审计聚合小修（后补）。
- warn → enforce 的升级标准建议：该边该条件在 ≥100 条 warn 记录上与人工/事后裁定的一致率达到约定线，由人工改 Config 生效。
