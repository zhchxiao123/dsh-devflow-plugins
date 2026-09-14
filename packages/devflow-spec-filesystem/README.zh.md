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
| `maxNetGrowthBytes` | `8192` | 单次写入的**净**增长上限：新文件大小减去它取代的一切。合并通常为负因而恒过——把聚类合并按纯新增计费，恰恰会拒绝唯一能让集合缩小的动作。它预算的是可评审性而非上下文：正文从不成批到达模型，所以大文档的代价落在必须维护它为真的人身上。 |

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

`symbol` 与 `content-hash` 按被引文件的扩展名分发到各语言的求值器；没有任何求值器认领的文件报 `unevaluable`——只有 churn anchor 能看住它。

| 语言 | 扩展名 | 顶层符号 | 规范化 |
|---|---|---|---|
| TypeScript / JavaScript | `.ts` / `.tsx` / `.js` / `.jsx` 及其 `m` / `c` 变体 | 函数、类、interface、类型别名、enum 与变量语句；多声明子语句的任一名字都解析到整条语句 | 去掉注释与语句分号，折叠空白 |
| Python | `.py` / `.pyi` | 模块级 `def` / `class` / 单名赋值；带装饰器的定义按内层名字匹配，连同装饰器一起进 hash | 去掉注释、标记 block 边界——缩进是语义——并去掉惰性尾逗号；docstring 与引号风格留在 hash 内 |
| Go | `.go` | `func`、`type`、`var`、`const`——`const (...)` / `var (...)` / `type (...)` 组内任一名字锚到整个声明块——以及按 `Type.Name` 引用的方法 | 去掉注释与 gofmt 展开复合字面量时的尾逗号；此外不动任何东西，因为 gofmt 输出没有行尾分号，而 `for` 子句里的 `;` 是语义 |

**规范化去掉格式化工具可能移动的，保留实现变更才会移动的**，因此重排版不会移动 hash，而改动一行会。TypeScript 的语句分号是刻意去掉的：它是各工具最常有分歧的那个格式维度，如果一次格式化加上分号就把全仓 anchor 打成过期，结果只会是**训练所有人忽略这个信号**。注释经各语言自己的解析器剥离而非正则——正则分不清字符串字面量里的 `//` 和真注释。

**规范化规则与文法都在 hash 域内。** 改动某语言的规范化——或升级它的文法——会让该语言全部 content-hash anchor 一次性过期，因此 Python 与 Go 的文法（`tree-sitter-python`、`tree-sitter-go`，其 wasm 经 `web-tree-sitter` 加载）按精确版本钉死，且它们的 npm install 脚本被刻意拦下：始终只加载 tarball 自带的 wasm，绝不做原生构建。

git 每个 store 只探测一次。不在工作树内时求值器根本拿不到查询函数，因此 churn anchor 报 `unevaluable`——**绝不是 `fresh`**。

## 写入路径

`write` 在碰文件系统之前依次拒绝：id 合法性、`Source of truth` 小节、至少一个 anchor、双向引用关系，然后是存在性，最后是 anchor 求值。每个声明的 anchor 都必须求值为 `fresh`——**一篇文档不得一出生就是过期的**。文件先写临时路径再 rename，失败的写入不会留下半篇文档。

领域拒绝解析为 `ok: false` 并带稳定 code。基础设施故障——路径存在却读不了、根目录不可写——则 reject，因为它们不是关于这篇文档的裁决。

## Model Experience

间接经由 `dsh-devflow-spec-tool`；本 Provider 不注册任何提示词或 schema。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **没有引用索引。** 没有任何地方记录哪些卡片触及过哪篇文档，因此「这篇几个月没人引用了」无法回答。推导它意味着每次查询都要读遍每张卡的 `spec-refs` 登记——成本随看板规模无上界，而其余健康信号都以文档数为界。它想要的形态是**登记时维护的索引**，不是读取时的全表扫描。
- **一次读取仍为每个被引文件付一次 `stat`。** 解析缓存正是以这些 stat 为键，所以未改动的文件在 store 生命期内只解析一次；但身份检查本身不缓存，也不该缓存——它正是让一次编辑在下一次读取时立刻可见的东西。
- **`symbol` 与 `content-hash` 只达及配有求值器的语言**——今天是 TypeScript/JavaScript、Python 与 Go；Rust 与 Java 是计划中的下一对。没有求值器认领的文件只能挂 `churn`，两种符号类 anchor 对它报 `unevaluable` 而不是放行。
- **shell 写入绕过守卫。** fs guard 是工具平面上的策略围栏，不是内核边界——这与卡片 journal 已有的暴露面相同，不是本 store 引入的新问题。
- **anchor 每次读取都重新求值，只是变便宜了。** 裁决本身从不缓存，被缓存的只是它背后的解析——因此一次读取报告的永远是当下的代码树，而不是曾经的。
