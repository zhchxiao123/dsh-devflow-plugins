# Agent Note: pull request 是 worktree 仪式的一部分，不是两种合并方式里的一种

Status: implemented

[English](2026-10-08-devflow-fixed-pull-request-flow.md) | 中文

## Problem

worktree runbook 的仪式收尾在「Merge the branch (directly or through a pull request)」上，而那个括号就是这条线关于「提交工作」说过的全部。什么时候开 request、它的 body 必须交代什么、谁来合、卡上记下关于它的什么——全都没有定义，于是每个跑 devflow 的项目各自发明一套答案，而读一条分支 diff 的评审者，也没有任何理由去看随它一起送达的卡状态。

同一句含糊话还有三份副本——runbook、`docs/devflow.md` 走读、`devflow-worktree` 的一段式契约——也就是三个能让答案各自漂移的地方。

卡上同样没有任何东西说明它的工作被提交到了哪里。journal 记下了每一次 stage 移动和每一条 artifact，然后分支就不留痕迹地去了 GitHub。

## Decision

runbook 承载一条固定的六步流程，在卡自己的 worktree 里执行：确认卡已提交、推分支、用 `gh pr create` 以 conventional-commit 标题和由卡推导出的 body 开 request、把这个 request 作为 `pull-request` artifact 登记到卡上，然后在 CI 全绿且卡仍能 fold 时合并。拆除一节保留它一向做的那三件事，并从合并之后开始。

body 的形状以代码块内嵌在 runbook 里，而不是作为第二份 asset：卡与它到达的 stage、一段话说清为什么、三个勾选框交代随合并送达的卡状态，以及对任何故意留红之物的声明。

`pull-request` artifact 带 `card`、`kind`、`url`、`base`、`head`，并且登记在 request **存在之后**。这与必须在分支存在之前 attach 的派遣 artifact 正好互为镜像，runbook 把两种顺序并排陈述：派遣 attach 晚了会让分叉两侧同时写这张卡，而登记 attach 早了则没有 URL 可记。这条登记作为分支上的又一个 commit 落地，被它所指名的那个 request 收走。

这条流程是仪式，不是门禁。CI 本来就在每个 request 上跑完这个仓库拥有的每一道检查，而 `devflow-artifact-gate` 的 cookbook 现在带上了那一行配置——部署方想让看板拒绝「没有任何 request 承载过」的 `done` 时就加上它。

`devflow-worktree` 的 skill 目录描述把这条流程和它的触发词广告了出去，因为目录那一行是唯一能让 runbook 被加载的东西。没有东西指向的流程不叫固定，散文怎么写都一样。

### 为什么这条 artifact 没有 `merged` 字段

它记录的是 request 开过。那个 request 有没有合并，是 `git log` 能直接回答的问题；在卡上声称这件事，代价是合并之后再从主 checkout attach 一次、提交一次，只为复述一个 git 已经持有的事实。

后果是：那道可选门禁买到的东西比它的边键看起来要少——配在 `testing->done` 上，它拒绝的是没有任何 request 承载过的卡，而不是 request 仍然开着的卡。cookbook 把这一点写在 snippet 旁边，因为只读 YAML 的部署方会假定前一种更强的保证。

## Alternatives considered

**自成一体的 transition waterfall 门禁。** 这样一道门禁唯一能读的状态就是 `pull-request` artifact，而「检查某条边要求的 artifact kind」正是 `devflow-artifact-gate` 已经从配置里做的事。新包只会复制一份这条线已经发布的配置。

**带 `check.sh` 的 iron rule。** iron rule 把正文常驻在每个请求里——这对义务是正确的价格，对一条刻意不强制的流程则是错误的价格。runbook 的判断力按需加载，在不提交工作的那些轮次里不花一分钱。

**为「已提交」新增一个 stage 或 `CardLocation`。** stage 集合是刻意闭合的。加一个成员要动状态机、三种 service class 的边、以及每个读 stage 的消费者——只为表示一个活在 git 和 GitHub 上、而不在看板上的事实。

**由 devflow 出一个工具或命令去开 request。** 这条线没有 GitHub 写入面：`github-sync` 刻意只读、不写 GitHub，并把 pull request 从它的摄入里过滤掉。通过 devflow 去开 request，意味着为一个 `gh` 已经在 agent 手里完成的步骤立起那个面，还会在一条以 harness agent 为执行者的流程里塞进第二个行动者。

**把 body 形状作为独立 asset 文件发布。** 消费方得去 `node_modules/@zhchxiao123/dsh-devflow-worktree/assets/` 底下找它。内嵌在 runbook 里，它在被需要的那一刻随一份已经打开的 skill 正文一起到场。

## Consequences

每个跑这个 bundle 的项目都拿到同一条提交流程，由 skill 目录广告出去，并且能从用户真正会说的那些词触达。卡现在记录了它的工作被提交到哪里，于是 journal 覆盖的是分支的整个生命，而不是停在它最后一次 transition。

想让看板强制这条流程的部署方加四行配置。什么都不配的则把流程留在仪式层面——压制 skill 的部署方得到的也是这个：判断力，而非保证，和这条线其余部分做的是同一笔交易。

目录描述现在用掉了 500 字符预算里的 474。下一件值得在那里广告的东西，得挤掉现有的某一样。

这个仓库的 `.github/PULL_REQUEST_TEMPLATE.md` 是那份已发布形状的一个实例，而不是形状本身，两者可能漂移。模板的头部注释点名 runbook 为权威，这样无论读到哪一份，读者都知道谁该让位。
