# Agent Note:devflow —— 检查与追加落在同一把锁里

Status: implemented

[English](2026-08-27-devflow-commit-lock.md) | 中文

## Problem

一次转移做的每一项检查 —— revision 的比较并交换、边的合法性、返工理由 —— 都是针对 `commitTransition` 开头读到的卡片求值的,而依据这些检查执行的追加发生在 `devflow/transition` 波布**之后**。那道波布正是部署的门禁命令运行的地方。配了 `'developing->reviewing': ['pnpm run test']` 的部署,"revision 3 是当前值"与"写入 revision 4"之间的距离,就是测试套件的执行时长。

`serialized()` 在单个 provider 实例内部关上了这个窗口。它对跨实例毫无作用,而两个进程共用一个 root 是再普通不过的情形:一个 harness 加一次 `/devflow` 调用、两个 harness、一个与 CI 共享的检出。两者都读到 revision 3,都通过全部检查,都追加 revision 4。

结果不是"更新丢失"。`foldJournal` 要求 revision 连续,也要求每条转移从上一条到达的位置出发,所以第二次追加让 journal **结构性非法** —— 而 store 的读路径是刻意 fail-loud 的。卡片就此永久不可读,而 journal 是权威,别的东西也救不回来。**一张卡的完整历史,恰恰是这套设计承诺要保住的唯一一样东西。**

同一个缺口还独立地破坏合法性:在门禁执行期间被打成 `blocked` 的卡片,照样会收到门禁批准的那次移动,写下的 `from` 是卡片已经不在的位置。

## Decision

**提交锁只包住重新校验与追加,不包别的。** 波布做出决定之后,`committing()` 以 `O_EXCL` 创建卡片目录下的 `commit.lock`,重读 journal 的 revision,只有当它仍等于此前每一项检查所依据的那个 revision 时才追加。revision 未变即证明整个检查块依然成立 —— 因为卡片的位置只随它的 revision 移动。

这把锁**刻意不覆盖**调用方自己的检查与波布。门禁命令要跑几分钟;横跨它们持锁,会让无关的提交排在一个测试套件后面,也会把每一次门禁崩溃变成一张卡死。

输掉这场竞争的调用方拿到 `revision-mismatch` —— 它本来就要处理的 code,消息点明是门禁期间卡片被移走。始终拿不到锁的调用方拿到新的 `write-contended`:什么都没写,原样重试即可。

被否决的方案:

- **要求调用方持有卡片租约。** 调查否掉了它:在所有写路径中,只有 `devflow_take` 和 driver 会认领。`/devflow move`、普通的 `devflow_transition`、以及全部 `attachArtifact` 都不认领,所以这条规则要么只能告警 —— 损坏通道照旧敞开 —— 要么打断五个调用方里的三个。更糟的是,driver 以 `{kind:'command'}` 持租约,而实际写入的子代理是 `{kind:'agent'}`,身份比对会拒绝掉唯一一个正确使用租约的消费者。
- **先追加,再校验并回滚。** journal 是只追加的;截断式回滚把这条性质丢掉了,而且 `foldJournal` 照样会看见中间态。
- **不加锁,只重新校验。** 窗口从分钟压到微秒,但没有关上,而漏过去的是不可恢复的数据损坏,不是一次重试。

锁的过期窗口与重试预算是固定常量而非 `Config` 字段。它们约束的是一读一追加的内部临界区;部署方在这里没有可调的东西,而一个长到值得调的窗口,只能说明锁被持在了不该持的地方。

## Consequences

`TransitionRejectionCode` 与 `ArtifactResult` 的 code 联合各自新增 `write-contended`。本线中没有任何消费者对二者做穷尽 switch,因此这项新增是兼容的;做穷尽 switch 的消费者需要补一个分支。

同一张卡上的并发提交现在跨进程串行化,而不再损坏。**不同**卡片上的提交不受影响 —— 锁是按卡片目录的,与 `serialized()` 的 root + id 键一致。

在取锁与释放之间被杀死的进程会留下锁文件。下一次提交会打破超过过期窗口的锁,因此恢复不需要人工介入;此前在同样情形下留下的是一次写了一半的提交,那更糟,而且是静默的。

`transition-contention.spec.ts` 就是促成这一切的那个用例:它像门禁一样把波布按住,从第二个实例提交,然后断言第一次提交被拒绝、卡片仍然可读。在修复之前,它断言的是相反的结论,并且通过。
