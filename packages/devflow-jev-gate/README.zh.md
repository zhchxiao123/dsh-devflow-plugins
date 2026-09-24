# @zhchxiao123/dsh-devflow-jev-gate

[English](README.md) | 中文

[`ctx.devflow`](../devflow/README.zh.md) 流转瀑布上的判断策略：在配置的流转边上经 [`ctx.devflowJev`](../devflow-jev/README.zh.md) 运行阶段 rubric，并把判决记入流转 journal 的 gate checks。本插件是纯 Consumer——不自带 rubric、存储或任何判断机制。

## 行为

每条配置边指定要运行的评估类别和两种模式之一：

- **warn**（每条边的起点）：判决作为 gate check 记录在放行的流转上——每个评估一行，写明评估记录 id，完整答案与后续的人工 accept/reject 都可从 journal 追溯——移动始终放行。warn 记录就是在授予模型否决权之前必须先存在的校准数据。
- **enforce**：仅当显式配置的条件成立时否决，否决理由携带触发它的具体数字。判断不可用只在该边选择了 `failClosed: true` 时才否决；低置信的高风险分永远不会在置信下限之下否决。

未配置的边原样委托。失败或超时的判断只会让自己失声，绝不会误伤移动：在 warn 边上它成为放行记录里的一条 `unavailable` 备注。

## 配置

```yaml
- name: '@zhchxiao123/dsh-devflow-jev-gate'
  config:
    edges:
      - edge: developing->reviewing
        kinds: [review-scope, implementation-risk]
        mode: warn
        timeoutMs: 8000
      - edge: testing->done
        kinds: [release-readiness]
        mode: enforce
        timeoutMs: 8000
        failClosed: false
        veto:
          releaseBlockedMass: 0.5
```

`veto.releaseBlockedMass` 在发布判断的 `P(blocked) + P(unavailable)` 达到该概率质量时否决；`veto.riskScore`（可配 `veto.riskConfidence`）在高且够置信的 `changeRisk` 分数上否决。每个条件都要求该边运行能回答它的评估——否则配置在加载时即报错。
