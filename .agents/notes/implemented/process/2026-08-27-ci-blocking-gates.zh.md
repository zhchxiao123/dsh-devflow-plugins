# Agent Note:CI 在它能判定的地方阻断,并在代码接触平台的地方运行

Status: implemented

[English](2026-08-27-ci-blocking-gates.md) | 中文

## Problem

门禁上有两个洞,都会让一次改动未经检验地抵达 tag。

**preflight 在 CI 里是建议性的。** 它跑在 `continue-on-error: true` 下,理由写得清楚也确实成立:它的某一项检查询问"这个版本是否已在 npm 上",而在 pull request 上,每次提交的答案都是"还没有"。但那个标记作用于**整次运行**,不是那一项检查,于是 preflight 的**每一项**都不再阻断 —— 包括它自己源码里点名为"这里唯一一种会毁掉整个 harness 的失败":声明了 `dsh.client` 却不带 `lib/client.js`,harness 对此的处理不是降级安装,而是**拒绝启动**。打包回归因此只能由 release 工作流拦下,而那正是犯错代价最高的时刻。

一旦说破,切分点很好看:preflight 的检查里,只有一项与发布时机有关。manifest 指向 tarball 中不存在的目标、残留的 `workspace:` 范围、tarball 不带的 bundle patch、没有 bundle 的 client 声明、漂移的版本号 —— 这些在 pull request 上和在发布时的答案完全一样。

**CI 只跑一个平台。** `ubuntu-latest`、Node 22、无 matrix。而 `devflow-filesystem` 是本线最大的包,也是它与操作系统接触的地方:claim 与 commit lock 的 `O_EXCL` 创建、`mtime` 过期判定、`rename`、测试里的 `chmod`,以及卡片目录名 —— 它的唯一性假设文件系统区分大小写。Windows 让 `chmod` 基本失效,APFS 默认不区分大小写,`rename` 跨卷会失败。一条声称"装了 harness 的地方就能跑"的插件线,只在 harness 能跑的平台中的一个上被验证过。

## Decision

**CI 跑的是 `preflight --no-registry`,并且阻断。** 这个标记去掉 registry 查询、保留其余全部,于是能在 pull request 上判定的检查就去判定。release 工作流仍跑完整形态 —— 在那里,registry 那个问题既可回答,也值得问。

被否决的替代方案是让 preflight 自己识别"是否处于发布上下文"并跳过该检查:那会把一个关于调用方的推断塞进一个价值就在于"只报告 tarball 事实"的脚本里。

**两个 job,而不是一个 matrix。** typecheck、lint 与 tarball 检查在每个平台上的答案完全相同,付三份钱什么也买不到,它们留在最便宜的 runner 上。会因平台而异的是测试套件,所以它同时跑在 macOS 与 Windows 上,并配 `fail-fast: false`,让一个平台的失败不掩盖另一个的。

**`concurrency` 取消分支上被取代的运行,但不取消 `main` 上的。** 分支上更新的一次推送让更早的那次运行失去意义;而 `main` 上的运行是"`main` 当时是什么样"的记录,应当让它跑完。

## Consequences

打包回归现在会让 pull request 失败,而不是让 release 失败。版本漂移检查随之一起前移 —— 这一点很要紧,因为让十一份 manifest 保持同步的只有 `set-version` 一个东西。

**新平台预期会暴露既有失败**,而那正是加它们的目的。Windows 上最明显的候选是那条用 `chmod 0o444` 证明 park 无法写入 journal 的用例 —— 在那里文件模式基本不起作用。这类失败属于平台,不属于本次改动:它应当被登记为独立 issue;如果确实阻塞,就把那个平台暂时标记 `continue-on-error`,并把原因与追踪链接写进 workflow —— **绝不通过删掉断言来解决**。

pull request 上的 CI 现在占三个 runner 而不是一个。分支上的 `cancel-in-progress` 通过不让被取代的运行跑完,收回了其中一部分。
