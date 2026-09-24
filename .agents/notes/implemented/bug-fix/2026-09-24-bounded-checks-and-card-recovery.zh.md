# Agent Note: 有界判断检查与卡片级恢复

Status: implemented

## Problem

侧边栏频繁出现"已中断"，且都停在"已处理 0/N"。链条是：单个判断检查没有自己的截止时间，provider 一挂起整个 run 就停在 `running` 好几分钟；开发环境 harness 重启频繁；`recover()` 于是如实把每个孤儿 run 标为 interrupted；而续跑要进详情页，没人去点。同时 `unavailable` 评估直接引用 provider 的英文原文、结束的审计挂着不含决策信息的"执行结束"徽标，侧边栏读起来全是黑话。

## Decision

把病因限界、把恢复放到手边、守住执行器规则。

`JevRunDefinition` 新增 `checkTimeoutMs`：超过截止时间的检查记为 `JEV_TIMEOUT` 失败，run 继续前进，在有界时间内以 `completed-with-errors` 收束，而不是把中断窗口一直敞着。调用方取消经 run 信号保持原义——未配置截止时间时，provider 侧的 `JEV_ABORTED` 依旧按取消处理，与从前完全一致。审计与单次评估从 `policy.judgementDeadlineMs` 取截止时间（默认 60 秒：SDK 20 秒超时下三次传输尝试）；generic run 从 `jev-runs` 插件配置取。store 在文件边界校验该字段。

面板把恢复做成一键：可续跑的 run/审计卡片自带续跑按钮，并写明是重启造成的中断、已完成检查会保留。结束的审计在原运行状态徽标处直接显示结论——"执行结束"不决定任何事，有结论后不再出现。`unavailable` 评估按 `JevError` code 显示失败类别（超时、限流、不可达、凭据缺失……），不再引用 provider 原文。

**启动时自动续跑被否决**，尽管 issue #50 最初这样要求：Harness agent 是唯一的工作流执行器，插件在没有属主 agent 的情况下自行重发判断 API 调用，就是换了名字的第二个后台编排器。因此续跑保持由人或 agent 发起——卡片按钮与 `jev_control resume`——而截止时间的工作已消除了大部分需要续跑的场合。

## Alternatives considered

- 面板打开时自动续跑：仍是在一次视图渲染上花 API 预算的自动化；与启动续跑一并否决。
- run 级而非检查级截止时间：一份预算摊给 N 个检查会饿死尾部；按检查限界让每次判断的边界一致、失败可归因。
- 评估列表卡片内联 accept/reject：accept 会创建任务卡；这一后果刻意保留在详情页的一次点击距离上。

## Consequences

中断变得罕见（run 现在在有界时间内结束）且廉价（一键恢复、已完成检查保留）。provider 不稳时 `completed-with-errors` 会比 `interrupted` 更常见——这是诚实的交换：它可续跑，且逐个写明失败检查。想要旧的无界等待的部署可调大 `judgementDeadlineMs`/`checkTimeoutMs`。校准导出能看到以前丢失在中断里的 `JEV_TIMEOUT` 行。
