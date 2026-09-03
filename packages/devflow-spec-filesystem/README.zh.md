# @zhchxiao123/dsh-devflow-spec-filesystem

[English](README.md) | 中文

**[spec 缝](../devflow-spec/README.zh.md)的文件 Service Provider**：架构文档存放在 `<root>/<id>.md`，每次读取都对工作树重新求值它的 anchor。

## 布局与配置

```yaml
- name: '@zhchxiao123/dsh-devflow-spec-filesystem'
  config:
    root: .devflow/spec      # 文档目录；相对路径对 cwd 解析
    repoRoot: .              # anchor 的相对文件路径对它解析
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `.devflow/spec` | 调用方未给出 root 时使用的默认 spec 根 |
| `repoRoot` | `.` | anchor 文件路径解析所依据的仓库根 |

默认根位于 **`.devflow/` 之内**，而 `@zhchxiao123/dsh-devflow-fs-guard` 按目录名匹配，已经拒绝文件工具写入该子树。这不是巧合：它让本 store 成为**唯一写路径**，而不只是"本意如此"的写路径，且无需为它增加第二条守卫配置。

一篇文档是 frontmatter 加 Markdown 正文：

```markdown
---
title: Error Handling
description: 域拒绝与基础设施失败的分野
updatedAt: 2026-09-02T00:00:00.000Z
anchors:
  - id: a1
    kind: symbol
    file: packages/devflow/src/types.ts
    symbol: CreateRejectionCode
---

## Source of truth

| Anchor | 指向 |
|---|---|
| `a1` | `types.ts#CreateRejectionCode` |

拒绝码是一个封闭集合 [[a1]]。
```

`updatedAt` 由 store 在写入时刻盖上，**绝不读取文件系统 mtime**——checkout、复制、容器构建都会重置 mtime，而 churn anchor 要拿它做比较基准。

## Anchor 求值

| 类型 | 如何判定 |
|---|---|
| `symbol` | 解析文件并查找该符号 |
| `content-hash` | 重新计算符号规范化体的 hash 并比对 |
| `churn` | 对该文件跑 `git log -1 --format=%cI`，与 `updatedAt` 比较 |

**规范化会去掉注释与语句分号**并折叠空白，因此重排版不会移动 hash，而改动一行会。分号是刻意去掉的：它是各工具最常有分歧的那个格式维度，如果一次格式化加上分号就把全仓 anchor 打成过期，结果只会是**训练所有人忽略这个信号**。注释经 TypeScript 扫描器剥离而非正则——正则分不清字符串字面量里的 `//` 和真注释。

git 每个 store 只探测一次。不在工作树内时求值器根本拿不到查询函数，因此 churn anchor 报 `unevaluable`——**绝不是 `fresh`**。

## 写入路径

`write` 在碰文件系统之前依次拒绝：id 合法性、`Source of truth` 小节、至少一个 anchor、双向引用关系，然后是存在性，最后是 anchor 求值。每个声明的 anchor 都必须求值为 `fresh`——**一篇文档不得一出生就是过期的**。文件先写临时路径再 rename，失败的写入不会留下半篇文档。

领域拒绝解析为 `ok: false` 并带稳定 code。基础设施故障——路径存在却读不了、根目录不可写——则 reject，因为它们不是关于这篇文档的裁决。

## Model Experience

间接经由 `dsh-devflow-spec-tool`；本 Provider 不注册任何提示词或 schema。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **无求值缓存。** 每次读取都重新解析被引文件。缓存形态已设计好（以被引文件的 size 与 mtime 为键，照 `dsh-devflow-agent-gate` 的裁决缓存，故障从不缓存），但没有实现：目前还没有需要它的规模化消费者，而这条线不保留无人读取的表面。
- **`symbol` 与 `content-hash` 仅支持 TypeScript。** 没有解析器读得懂的文件只能挂 `churn`；求值器对其余情况报 `unevaluable` 而不是放行。
- **shell 写入绕过守卫。** fs guard 是工具平面上的策略围栏，不是内核边界——这与卡片 journal 已有的暴露面相同，不是本 store 引入的新问题。
- **只做创建。** 修订或替换已有文档不属于本操作；`exists` 会拒绝。
