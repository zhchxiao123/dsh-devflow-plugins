# 子 agent 模型路由

把派发出去的子 agent 路由到其任务应得的模型档位。一份有序的档位表同时充当三件事：判断评分的 rubric、告诉模型可选什么的表、以及把档位换回路由的映射。本包消费 `ctx.jev`，不知道由谁作答 —— 与 `@zhchxiao123/dsh-jev-typesafe` 组装，或与任何提供该 seam 的实现组装。

```yaml
- jev-model-router:
    tools: [subagent]
    tiers:
      - key: cheap
        when: '机械改写与查找，答案已经明确。'
        provider: deepseek
        model: deepseek-chat
      - key: standard
        when: '常规实现或排查：读若干文件，局部推理。'
        provider: deepseek
        model: deepseek-reasoner
      - key: deep
        when: '跨层设计、并发或兼容性变更，或错判代价高的交付前检查。'
        provider: deepseek
        model: deepseek-reasoner
        reasoningEffort: high
```

它要求派发工具暴露路由字段。在 `@deepseek-ai/dsh-tool-subagent` 上设 `modelSelectionSettings: true`，并记录非空的 `subagent-model-selection` 路由表；否则模型没有 `provider`/`model` 可填，本路由器只会 warn 一次然后什么都不做。

## 怎么路由

**guidance 让「指定路由」成为常态。** 每次组装的 prompt 都带上档位表，以及「每次派发都要设 `provider` 和 `model`」这条指示。这是便宜的那一半：选对的模型永远不会被打断。

**判断逐次检查派发。** 待派发的 description 与 prompt 构成一个 Score 问题，其 rubric 就是档位本身 —— 所以某档的 `when` 是定义该档位的唯一处。分数是概率加权的，可能落在两档之间；正中间的值**向上**取整，因为难任务配弱模型的代价是结果错，而配强模型的代价是钱，这两者不是同一种错误。

**不一致则驳回一次。** 当选中的路由不是判出档位的路由（包括一个路由都没指定）时，该次调用被拒绝，理由里点名该档位、其确切路由、以及该档覆盖的场景。模型按该路由重发同一次派发。

只驳回一次。身份用派发的 prompt 而不是 tool call id —— 纠正后的派发是一次新调用、新 id；对同一 prompt 的第二次拒绝会把路由偏好变成一个死掉的派发，所以第二次尝试无论选了什么都放行。

## 降级模式

`ctx.jev.configurationStatus()` 报告的是**本地**配置 —— 凭据引用能否解析，而不是远端 API 是否可达或愿意作答。当它不是 `configured` 时，纠正停摆、guidance 留下：同一个决策，由模型来做，依据的是判断本会评分的同一批档位描述。没有派发被阻断，也不会产生判断调用。

| 凭据 | `list_subagent_models` | 行为 |
|---|---|---|
| configured | 可见 | guidance + 逐次判断 + 不一致时驳回一次 |
| unconfigured / unknown | 可见 | 仅 guidance —— 模型自选，不被纠正 |
| 任意 | 不存在 | 空转；warn 一次并点名部署缺了什么 |

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `tiers` | — 必填 | 档位，由弱到强。至少两档 —— 一档没有可判别的东西。每档需要 `key`、`when`、`provider`、`model`；`reasoningEffort` 可选。两档不得共用一条路由，否则点名任一档的纠正都无法从派发自身的字段中核实。 |
| `tools` | `['subagent']` | 本路由器管辖的派发工具名。 |
| `judgeTimeoutMs` | `2500` | 单次路由判断的 deadline。与 provider 自己的超时分开 —— 后者由该 seam 的所有消费者共用，其尺度是给没有派发在等的工作定的。 |

配置错误在 load 期失败，并点名字段。

**不要同时把档位路由写进派发工具自己的 `agentOptions`。** 那个字段正是模型什么都没填时工具会发出的值，两处都填会让「模型选了这个」和「配置填了这个」无法区分，路由器也就再也分不清一次派发是需要路由还是已经路由过了。

## 为什么是驳回纠正，而不是注入路由

两条可用的 seam 都无法绕过模型去设置路由。

`tools/pre-execute` 不能改写调用的入参 —— 等到策略监听器运行时，入参已经被记录和呈现过了，所以决策只有 allow、deny、ask。而 subagent provider 根本看不到后台派发：在 `backgroundMode: continuable` 下省略 `run_in_background` 默认为 true，该路径经 continuation manager 创建子 agent，只会问 provider 要不要用父历史做种子。因此 provider 装饰器只能覆盖显式前台的少数派发，而出厂 preset 并没有把派发放在那里。

所以本包做的是唯一能覆盖两条路径的事：判断，并给出模型能据以行动的拒绝理由。

## 已知限制

**不是硬保证。** 模型可能两次都选错档；第二次会放行。在 harness 当前的 seam 下，没有任何机制既是硬保证又覆盖完整 —— provider 装饰器是硬的但只覆盖前台，驳回纠正覆盖完整但是建议性的。

**每次受管派发多一次判断往返。** 由 `judgeTimeoutMs` 兜住，超时即放行。在派发时刻判断而不是在 prompt 组装时判断，换来的是用真实的派发 prompt 作证据，而不是对一次还没写出来的派发瞎猜。

**不校验 `reasoningEffort`。** 档位的路由只按 `provider` 与 `model` 比对；路由正确但 effort 不同的派发不会被纠正。这两个字段标识一个档位，effort 随 guidance 和纠正文案一并给出。

**没有路由记录。** 判了什么、纠正了什么都留在会话历史里 —— 被拒绝的 tool result 是持久且可重放的 —— 而不是写进一份专门的日志。
