# TypeSafe Jev provider

用 [TypeSafe 的 Jev](https://docs.typesafe.ai) 经 System One API 来回答 `ctx.jev`。挂上这一行就完成了 seam 的注册——`@zhchxiao123/dsh-jev` 只提供词汇和基类，别的什么都没有，所以组合里只需要这一行。

```yaml
- jev-typesafe:
    apiKeyRef: TYPESAFE_API_KEY
```

## Configuration

| 键 | 默认值 | 含义 |
|---|---|---|
| `apiKeyRef` | — 必填 | 指向 API key 的凭据引用。**每一次**调用都经 `ctx.credentials` 重新解析，因此轮换过的 key 会在下一次判断时生效，不需要重启。没有默认值：给它默认值等于替部署方选了一个凭据。 |
| `baseURL` | `https://api.typesafe.ai` | 端点根。带凭据、query 或 fragment 的会被拒绝。 |
| `model` | `jev-1.13.0` | 作答的模型。**是钉死的版本，不是 `jev-latest` 别名**：别名会随发布移动，而消费方的置信度阈值是对着产生它们的那个模型调出来的，于是一个悄悄变新的模型会在消费方自己的数据里表现为漂移。 |
| `timeoutMs` | `20000` | **每次尝试**的截止时间；每次重试各有自己的一份。 |
| `maxRetries` | `2` | 首次尝试之后的重试次数，用于限流拒绝与服务端失败。`0` 表示不重试。 |

配置错误在加载时失败并点名字段。引用名不符合凭据 seam 的标识符文法时同样在那里被拒，因此一个拼写错误是启动失败，而不是一个悄无声息永远不可用的能力。

## SDK 负责什么

`@typesafe-ai/sdk` 承担传输：带抖动的退避、限流拒绝时遵守 `retry-after`、每次尝试的截止时间，以及每种失败一个错误类。它**自身零依赖，并且每个请求都走全局 `fetch`**，所以部署方的出站代理策略对判断的作用与对 harness 其余部分完全一致。这条性质正是本包用 SDK 而不是自己写 HTTP 的原因：一个自带传输的客户端会悄悄绕过那条策略。

客户端是每次调用现构造而不是持有的。SDK 在构造时接收 API key，而 seam 每次调用重新解析它，所以一个被持有的客户端会把插件加载那一刻的 key 钉死。

## 失败分类

每种失败都以带 code 的 `JevError` 抵达调用方，因为运维上的应对不同：

| 发生了什么 | code |
|---|---|
| 引用解析为空，或查找本身抛出 | `JEV_CREDENTIAL_MISSING` |
| 调用方撤回了请求 | `JEV_ABORTED` |
| 单次尝试的截止时间到了 | `JEV_TIMEOUT` |
| 被限流拒绝，且重试已用尽 | `JEV_RATE_LIMITED` |
| 其它任何非成功状态，包括 key 被拒 | `JEV_HTTP_ERROR` |
| 根本联系不上服务 | `JEV_UNAVAILABLE` |
| 成功了但响应体里没有 answers | `JEV_BAD_RESPONSE` |

key 被拒归 `JEV_HTTP_ERROR` 而不是 `JEV_CREDENTIAL_MISSING`："配了但被拒"和"没配"是两个不同的问题，解决办法也不同。

解不出来的单个答案会被排除在响应之外，而不是报成一次失败，这样 seam 的规则才成立——一个没有可读答案的 question 是缺席，绝不会是一个没人量过的数字。

## Known limitations

**不分批。** 一次 `ask` 就是一次请求。Jev 的上限是每请求 64k tokens，其中 state 加上最长的那一个 question 另有 32k 的界，而待在界内是消费方的事——消费方知道自己能丢什么，本包不知道。

**不调用 `/v1/models`。** `model` 写错会在第一次判断时以 `JEV_HTTP_ERROR` 暴露，而不是在加载时。

**英语是这个模型最强的地方。** 其它语言（包括 CJK 文字）能处理，但不是同等水平。在信任任何针对非英语内容的阈值之前，先在自己的数据上测。

**响应 fixture 不是录制的。** 它们是按 SDK 自己的类型声明构造的——那是厂商对同一条线的机器可读契约，但仍然不是一次捕获。`tests/fixtures/README.md` 记录了这留下了什么没覆盖，以及怎么替换它们。
