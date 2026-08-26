# @zhchxiao123/dsh-devflow-gates

[English](README.md) | 中文

[`devflow/transition`](../devflow/README.zh.md) waterfall 上的命令门禁策略：配置了门禁的边在 journal 提交前经 `ctx.shell` 运行其门禁命令，失败的命令以携带有界输出摘要的拒绝理由否决移动。门禁命令完全存在于部署配置中——全局按边列表加按卡片 id 的覆盖——绝不在卡片的可写文件里，因此开发中的 agent 无法改写自己的门禁。

## 行为

对边 `from->to` 的一次尝试，守卫命令为存在时的 `cards[<卡片 id>][edge]`，否则 `edges[edge]`，否则无（无门禁的边原样委派）。命令按序经 `ctx.shell.resolve`/`run` 在卡片的工作区目录（attempt 所携 devflow root 的父目录）运行，`pnpm run test` 这样的门禁因此检查的是这张卡所属的代码；第一个非零退出（或被杀）即否决且不再运行后续命令，携带 `gate command failed: <command> (exit N | killed): <stderr+stdout 摘要>`，按 `maxFailureOutputChars` 截断。全绿门禁委派给其余 waterfall 监听器。

## 人工审批

列入 `approvals` 的边在其命令通过后额外要求一次一次性人工决定，经交互面（`ctx.approval`）应答——绝不经过模型对话，因为门禁的存在就是为了检查 agent。审批请求路由到发起 agent 的应答者（`attempt.by.session` 经 `ctx.agents` 解析）；获批的移动在其 journal 条目携带 `gate: { approvedBy: { kind: 'human' } }`，被拒绝或撤回的提问否决且无副作用。无可达应答者时——非 agent 发起者、未组合 approval 服务、或缝 fail-closed 的 `unavailable`——移动被否决且卡片停驻 `blocked`（`awaiting human approval for <edge>`，actor 为 `command devflow-gates`），使无人值守运行干净退出；人恢复卡片到被打断的阶段后重新尝试移动。

## 配置

```yaml
- id: devflow-gates
  name: '@zhchxiao123/dsh-devflow-gates'
  config:
    edges:
      'developing->reviewing': ['pnpm run test']
    cards:
      0042-retry-backoff:
        'developing->reviewing': ['pnpm run test -- packages/llm']
    maxFailureOutputChars: 2000
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `edges` | `{}` | 按 `from->to` 边的全局门禁命令。 |
| `cards` | `{}` | 按卡片覆盖，替换该边的全局列表。 |
| `approvals` | `[]` | 命令通过后还需一次性人工审批的边。 |
| `maxFailureOutputChars` | `2000` | 否决理由中失败输出摘要的字符上限。 |

不是 `<from>-><to>` 形式或含未知位置名的边键使加载失败。

## Model Experience

None, as gate vetoes reach a model only through the devflow tools' rejection text; this plugin registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **审批需要活跃的发起 agent** — approval 缝是 agent 作用域的，人或命令发起的移动在审批边上总是走停驻 blocked 路径；连 [`/devflow move`](../command-devflow/README.zh.md) 也经同一执行器、没有旁路，审批边只有携带可达审批应答者的 agent 才能跨过。
- **门禁命令以执行器默认工作目录与超时运行** — 按边的 cwd/超时覆盖等待有需要的消费者。
