# Agent Note: 通用 run 在调用内给出答案

Status: implemented

## Problem

`jev_run` 把每个通用检查单扔进后台 job，只返回一张票。调用方是单轮 agent：turn 结束进程退出，job 未写一笔就死掉，恢复逻辑将 run 标为已中断——于是每个 gate check 都停在"已中断 0/N"等人。工具用"稍后再查"回答一个 agent 现在就要答案的问题，而这个调用方没有"稍后"。

## Decision

通用 run 在调用操作内部执行完毕并直接返回答案；不留任何会被进程退出孤儿化的后台执行。每检查截止时间给等待设界；调用方取消——工具信号或显式 cancel——落为诚实的 `cancelled`，续跑只同步重执行未完成的检查。cancel 有意绕过运行锁：锁正被待取消的执行持有。控制权从"job 属主"改为"工作区"，面板无需活跃 agent 即可续跑/取消——重启后恰是这种处境。审计保留后台 job：全板扫描是唯一按设计跨越 turn 的形态，其属主模型仍然成立。

## Alternatives considered

- 保留 job、教 agent 轮询 `jev_list`：缺陷在票据模型本身，不在轮询纪律；单轮调用方无从轮询。
- 把 job 与 agent 属主解绑：进程退出孤儿化的病根仍在，且更深地违反"无后台编排器"规则。

## Consequences

gate check 在发问的那次工具调用内完成（或诚实失败）；通用 run 的"已中断"类别消失。最坏情形一次调用等待 N × checkTimeoutMs——截止时间配置就是杠杆。runs 插件卸下 jobs 依赖；`jev_control` 的 resume 返回完成结果而非 job id。
