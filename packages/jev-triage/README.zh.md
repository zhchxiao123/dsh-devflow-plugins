# Diff 分诊工具

注册 `jev_triage`：给 git 工作区里每个改动文件按评审风险打分，好让代码评审里昂贵的阅读花在需要的地方。它消费 `ctx.jev`，并不知道由谁来作答——把它和 `@zhchxiao123/dsh-jev-typesafe` 组合起来，或者和任何别的提供这个 seam 的东西组合起来。

```yaml
- jev-triage:
    skipBelow: 2
    confidenceFloor: 0.4
```

```
jev_triage { "cwd": "/path/to/repo" }
jev_triage { "cwd": "/path/to/repo", "base": "main" }
```

每个改动文件成为它自己的 question，携带它自己的 diff，全部在一次调用里作答。某个文件的 diff 放在那个文件自己的 question 里而不是共享的 state 里，因为一次调用中的每个 question 都针对同一个 state 作答——一个装着所有 diff 的 state 会让这些文件互相锚定。

## 规则

**只有当一个文件的分数低于 `skipBelow`，并且判断的置信度达到或高于 `confidenceFloor` 时，它才会被跳过。** 其它一切都是评审：高分、低置信、判断失败、二进制文件、超出批量大小的文件、对这次调用来说太大的 diff、缺失的答案、种类不对的答案。因此"分诊跳过了一个危险的东西"不是一件会发生的事——最坏的情况是一次没人需要的评审。

置信度先于分数检查，所以一个低置信的答案报告的是这一点，而不是那个它并不信任的分数。

被撤回的请求会被重新抛出，而不是并进上面这条规则。一次被取消的调用如果带着一整套保守的裁决回来，看起来就像它成功了。

## Configuration

| 键 | 默认值 | 含义 |
|---|---|---|
| `scoreLevels` | 五档 rubric，Trivial → Critical | 评分档位。它的长度就是分数上限，所以增减一档会让上限跟着走。至少两档——一档没有任何可区分的东西。每一档读作 `名称: 它涵盖什么`，冒号前的名称就是结果里显示的。 |
| `scoreInstruction` | 问这次改动有多大可能藏着值得专家评审的缺陷 | 风险是怎么向模型描述的。 |
| `skipBelow` | `2` | 低于这个分数的文件才可能被跳过。`0` 表示什么都不跳过，这是"保留工具挂载但一条都不采信"的做法。 |
| `confidenceFloor` | `0.4` | 低于这个置信度的，无论打了多少分都不跳过。 |
| `maxFiles` | `40` | 每次调用的文件数；其余的不打分直接评审。 |
| `maxFileChars` | `6000` | 单个文件的 diff 能进入模型的字符数；超出部分被截断，并且**仍然参与判断**，因为被截断的 diff 只会让判断更保守。 |
| `maxTotalChars` | `28000` | 一次调用的字符总量；超出之后的 question 不再发出，对应文件转为评审。 |
| `stdoutMaxBytes` | `4194304` | 收集 `git diff` 的字节数。**被截断的捕获是故障，不是一份更小的 diff**——半个文件的 diff 照样能解析，然后会被当作完整改动来打分。 |
| `timeoutMs` | `60000` | 整次调用的截止时间。只有组合了 `@deepseek-ai/dsh-tool-call-timeout-policy` 时才真正生效。 |

配置错误在加载时失败并点名字段。

## 它读什么

`git -C <repo> diff --no-color --src-prefix=a/ --dst-prefix=b/ --no-ext-diff <ref>`。前缀是强制指定的，这样无论本地的 `diff.mnemonicPrefix` 设成什么，切分都成立；`--no-ext-diff` 阻止外部 diff driver 把输出形状整个换掉。`ctx.shell` 接收的是一个命令**字符串**，所以仓库路径和 ref——两者都来自模型——在抵达它之前都被单引号包了起来。

## Known limitations

**未跟踪的文件不在覆盖范围内。** `git diff` 不列出它们。结果里会说明这一点；用 `git status` 列出它们。

**不分批。** 超出 `maxFiles` 的文件，以及超出 `maxTotalChars` 的 question，会转为评审而不是放进第二次调用。第二个请求是第二次部分失败的机会，而它换来的只是少读几个文件。

**没有跨会话的记录。** 工具自己的结果就是"判断了什么"的持久、可重放的账目——它落在会话的 `tool/result` 上并且能撑过一次重载。把一次跳过与评审后来发现的事实做比对，只能从会话历史里做，而不是从一份专门的日志里做。

**`timeoutMs` 需要一个策略插件。** 这个字段是声明了的，但真正执行它的是 `@deepseek-ai/dsh-tool-call-timeout-policy`；没有组合那一行时，这个截止时间只是建议。
