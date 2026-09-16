# @zhchxiao123/dsh-devflow-worktree

[English](README.md) | 中文

每卡一 worktree 的开发方式：一张卡、一条分支、一个 linked git worktree。
这个包交付两项贡献——承载仪式的 bundled `devflow-worktree-runbook` skill，
和 `devflow/transition` waterfall 上的一道围栏，把被派遣的卡限制在派遣记录
指名的 worktree 里。

## 为什么 worktree 天然就是一个工作区

Devflow 的每个 root 都从调用会话自己的目录解析（`<cwd>/.devflow`），而
`.devflow/` 是提交进仓库的。因此一个 linked worktree 检出的就是一块完整的
看板：分支携带卡，卡的工作区就是 worktree，闸门命令、review-gate review、
agent-gate 检查器全都在那里运行——这些包本来就锚定在卡的 devflow root 的
父目录。这里没有任何东西改变任何消费方解析目录的方式；这个包补上的是过程
（一个 skill），以及过程自身无法承载的那一条保证（围栏）。

## 仪式

runbook 的契约，一段话说完：在主板把卡走到 `ready`；attach 一条派遣
artifact——配置的 kind，默认 `worktree`，frontmatter 含 `branch`、`base`、
`worktree`——然后提交它并 `git worktree add <path> -b <branch>`，顺序不可
颠倒。在工作目录为该 worktree 的会话里开发：在那里 `devflow_take`，把代码
和卡状态一起提交到分支上，驱动卡走完它的边。合并分支让代码和 journal 一起
送达，然后删除 worktree 和分支。从派遣到合并，只有卡自己的 worktree 写这
张卡——两个 checkout 向同一份 journal 追加，合并出的 revision 冲突会让卡
不可读，这是有意的、大声的失败。

## 围栏

每次 transition，围栏读取移动中的卡（通过可选的 `devflow` 服务，按名字取
用），找配置 kind 的最新 artifact。没有这条 artifact：卡不受影响，围栏委
派下去。否则，transition 的工作区——attempt root 的父目录——必须规范化为
派遣记录的 `worktree`，或者该仓库的主工作树；主工作树按目录经
`git rev-parse --path-format=absolute --git-common-dir` 推导并缓存。主工
作树的放行正是让主 checkout 在 worktree 删除后还能归档或跟进已合并的卡的
通道。其余任何 checkout 都被 veto，理由点名两个目录；派遣记录不可读或格式
损坏同样 veto，因为一道靠猜的围栏放行的恰恰是这条记录存在的目的所要拦住的
写入。

## 配置

```yaml
- name: '@zhchxiao123/dsh-devflow-worktree'
  # config:
  #   artifactKind: worktree   # 必须与 artifact-gate 声明的 kind 一致
```

在部署的 artifact-gate 里声明该 kind 的结构，让派遣不可能被登记成残缺的：

```yaml
kinds:
  worktree:
    frontmatter: [branch, base, worktree]
```

## 已知限制

- **围栏只守 transition。**artifact 登记和建卡不设防：从错误的 checkout
  attach 依然是 runbook 禁止、而围栏看不见的双侧写入。attach 面同时也是逃
  生通道——被挪动的 worktree 靠 attach 一条指名当前路径的 artifact 重新派
  遣自己——把它也围起来会连恢复路径一起关掉。
- **非 git checkout 里的派遣一律 veto。**在任何 git 工作树之外的一份看板
  副本没有可放行的主工作树，对一个仪式永远不会产出的 checkout，这是
  fail-closed 的读法。
- **worktree 会话看不到 harness 的工作区注册。**automation、scheduler、
  github-sync 平面把会话目录解析到 harness 工作区注册表，而 worktree 不在
  其中；这些工具在 worktree 会话里会拒绝。它们是后台摄入面，不在开发内循
  环里，主 checkout 的会话继续服务它们。
