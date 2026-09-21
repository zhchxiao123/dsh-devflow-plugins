# Agent Note: 发布流水线跑了 CI 的测试套件，却没装 CI 的浏览器

Status: implemented

## Problem

`release.yml` 与 `ci.yml` 都会跑本仓库的完整门禁，而发布那一侧是**刻意**重跑的——
用它自己注释里的话说，"a release is the one action that cannot be taken back"。
但两个 workflow 对 runner 的准备不一样，只有 `ci.yml` 装了浏览器。

`ci.yml` 的 verify job 在门禁之前跑
`pnpm --filter @zhchxiao123/dsh-devflow-midscene exec playwright install --with-deps chromium`。
`release.yml` 则从 `pnpm install --frozen-lockfile` 直接跳到 `pnpm run verify`。
`devflow-midscene` 的验收 spec 要驱动一个真 Chromium；没有浏览器时它们不会跳过，
而是失败——`Failed to launch browser`，表现为
`expected 'infrastructure-error' to be 'passed'`。

于是同一道门禁在 PR 上全绿、在 tag 上全红。`devflow-midscene` 是在 `v0.4.0-dev.7`
之后合进来的，而 `v0.4.0-dev.9` 是那之后第一次发布尝试——这就是为什么一个存在了十天的
缺口，直到有人真去发版才暴露。

失败方式是良性的：`verify` 排在 `build`、`preflight`、`publish` 之前，所以什么都没发出去，
版本号也还空着可以重试。良性但不便宜：它消耗一个 tag，而这个 tag 要么移动、要么作废。

## Decision

`release.yml` 按 `ci.yml` 的方式装浏览器，位置在 install 之后、tag 校验之前。

这一步带注释说明它为什么存在，因为它的**缺席是不可见的**：`pnpm run verify` 本身
不会声明它需要一个浏览器，而下一个想精简发布流水线的人，会看到一条没有理由的
Playwright 安装并以为是误抄进来的。

`v0.4.0-dev.9` 被重新指向修复后的提交，而不是作废。移动 tag 通常是错的，但这个 tag
什么都没发布过——没有任何消费者见过这个版本；作废它只会在序列里留下一个空洞，
而那个空洞记录的仅仅是"某个 workflow 少了一步环境准备"。

## 这条是哪一类规则的实例

**跑同一道门禁的两个 workflow，必须准备同样的环境。** 这道门禁是 `pnpm run verify`，
而它并非自包含：它假定存在一个 `package.json` 无法替它安装的浏览器。`ci.yml` 与
`release.yml` 在准备上的任何分歧，都意味着发布门禁不再是 PR 通过的那道门禁——
而这恰好瓦解了发布时重跑门禁的全部意义。

当某个包给测试套件引入了新的外部运行期依赖——浏览器、数据库、系统库——它应当在
**同一次改动里**进入两个 workflow。

## Alternatives considered

**让测试套件自己装浏览器。** 在 `devflow-midscene` 里加 `globalSetup` 或 pretest 钩子，
能让 `verify` 自包含、且免疫于 workflow 漂移。暂不采用：`playwright install` 慢且依赖网络，
放进套件意味着每次本地 `vitest` 都会跑它，而本地通常浏览器早就在了。代价落在常用路径上，
去保护一条罕见路径。

**没有浏览器时跳过这些 spec。** 那是把一次响亮的失败换成一个静默的覆盖缺口，
而需要真 Chromium 的那些 spec，恰恰是在断言"验收是真的、不是 mock 的"。
一道发布门禁若悄悄停止检查它存在的理由，比它失败更糟。

**让 `release.yml` 以 reusable workflow 方式调用 `ci.yml`**，使准备工作在结构上无法分歧。
这是结构正确的修法，仍然开放。这次没采用，是因为 trusted publishing 的授权绑定在本
workflow 的**文件名**与 ref 上；重构这个 job 正是 `RELEASING.md` 警告过、需要先更新
每个包 trusted publisher 的那类改动——而那不是发布进行中该做的事。

**作废 `0.4.0-dev.9`，改发 `dev.10`。** 不采用：dev.9 什么都没发布，版本号是干净的；
而跳号会让未来的读者去寻找一个用掉了它的发布。

## Consequences

发布流水线慢了一次浏览器安装。这是"发布门禁等于 CI 跑过的那道门禁"的代价。

两个 workflow 的准备工作仍然是重复的，因此仍然可能漂移。上面那条 reusable workflow
是持久的修法，当前被 trusted publisher 重新绑定挡着；在它被采用之前，
给测试套件增加运行期依赖的包必须同时记得两个文件。`RELEASING.md` 已经记着相邻的
另一课——preflight 的盲区——两者同根：一道**看起来**和 PR 检查一样、实际不一样的
发布时检查。

## Related

- [preflight 的盲区](../../../../RELEASING.md) —— 同一次发布尝试中发现的另一个缺口：
  preflight 会放行一个永远发布不了的包。
