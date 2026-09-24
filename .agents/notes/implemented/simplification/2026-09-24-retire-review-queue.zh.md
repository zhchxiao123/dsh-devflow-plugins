# Agent Note: 退役复核队列——判断出的动作直接建卡

Status: implemented

## Problem

引入 Jev 本为减少人工审核，intake 路径却在制造它：`decide()` 把原始判断折叠成决策词汇，每个边界情形都停进"人工复核"队列等一次点击。用户的批评切中要害——原始判断（价值 2.17、风险 2.84、investigate 90%）本身就是有用的产物，叠在上面的抽象把数据又变回了工作量。

## Decision

`policy.autoCreate`（默认开）：需求评估的 `recommendedAction` 判为 `create` 或 `investigate`，即刻建卡，署名 `by: command`。阈值继续写入记录的 decision，但不再拦截建卡——卡片廉价且可放弃，放弃一张卡给校准的标签正是复核点击本要给的。`ask` 与 `reject` 不建卡；provider 失败不建卡；卡从 `draft` 起步，因为插件不推进阶段。显式 accept/reject 通道为 `autoCreate: false` 的部署保留，且 `acceptOnce` 现在接受任何开放提案而非仅 `propose` 决策——人工推翻阈值是正当的。

列表展示判断而非词汇：摘要携带 `keyAnswers`（价值、风险、动作及其概率），开放判断的徽标是判出的动作，摘要行是一行原始数字。只有仍在等待显式裁决的提案才算可行动。

## Alternatives considered

- 只放松阈值：队列和词汇都还在；被质疑的是抽象本身，不是常数。
- investigate 的卡自动转入 `designing`：否决——Harness agent 是唯一工作流执行器；建卡是机械式接收，转阶段是工作流。

## Consequences

autoCreate 下没有任何事等人：判定的工作以 draft 卡出现，不想要的卡被放弃，两种动作都为校准数据打标。五值决策词汇只作为评估记录里的数据存续。想要旧式把关的部署设 `autoCreate: false`，显式通道仍在。
