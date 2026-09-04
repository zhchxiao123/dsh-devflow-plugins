# @zhchxiao123/dsh-devflow-deploy

[English](README.md) | 中文

DeepSeek Harness 的持久部署能力。仓库里的 `deploy.yml` 声明本项目发布什么，
`deploy_*` 工具把它发布到服务器并报出可访问地址。

**发布出去的东西比会话活得久。** 这与
[`dsh-devflow-testenv`](../devflow-testenv/README.zh.md) 的承诺正好相反——后者保证
环境被拆干净。本包不把远端的任何东西注册为 effect：dispose 插件只会移除它的工具和
skill，已发布的每一个 release 原地不动。

## 清单

```yaml
targets:
  landing:
    kind: static
    build: pnpm run build
    dir: dist
    entry: index.html
```

`kind` 选择驱动。`build` 是可选的前置步骤。其余字段都属于该 kind，核心原样转交，
不做检查。

**target 名会成为 URL 路径**，因此限定为小写字母、数字和中间连字符。这条限制是
安全不变量——名字会进入远端路径——所以固定不可配置。

把 target 声明在仓库里、而不是作为工具入参传入，是刻意的：否则拼错一个字母就会
静默发布出第二个站点，而现在它是一个列出已声明 target 的校验错误。

## 配置

```yaml
- name: '@zhchxiao123/dsh-devflow-deploy'
  config:
    host: deploy@example.com          # 也可以是 ~/.ssh/config 里的别名
    drivers:
      static:
        remoteWebRoot: /srv/www       # Web 服务器服务的目录
        remoteReleasesRoot: /srv/releases
        baseUrl: https://example.com  # 对应 remoteWebRoot 的 URL 前缀
```

配置按 kind 分段放在 `drivers` 下，因为各 kind 的远端布局并不共享。核心**不知道**
某一段的形状——由该 kind 自己校验，与它校验自己的清单字段完全同理。一个 kind 都不配、
或配了本包不提供的 kind，都在 load 时失败。

地址字段没有默认值。猜出来的远端路径会让配置错误的组合把东西发布到没人看的地方，
所以配置不全时在 load 阶段就失败。`remoteReleasesRoot` 必须位于 `remoteWebRoot`
之外，这一条同样在 load 时校验。

共享项：`manifestPath`（`deploy.yml`）、`buildTimeoutMs`（600000）、
`remoteTimeoutMs`（120000）、`logTailBytes`（65536）、`graceMs`（5000）。
`static` 段专属：`keepReleases`（5）。

**配置里不出现任何凭证。** SSH 认证归 harness 所在的那台机器——密钥、agent、
`known_hosts`——本包不持有也不校验任何密钥材料。远端命令带 `BatchMode=yes`，
所以缺密钥是失败而不是弹出提示。

## 工具

| 工具 | 作用 |
|---|---|
| `deploy_target` | 构建、作为新 release 发布、切换过去、裁剪旧 release |
| `deploy_status` | 当前发布的是什么、地址是什么、回滚承诺是什么 |
| `deploy_rollback` | 回到更早的 release，不重新构建也不重新传输 |

捆绑的 `deploy-bootstrap` skill 负责写和修清单、发布前验证目标，以及在"向前修复"
与"回滚"之间做选择。

## 回滚承诺的三个等级

各类部署对象最大的差异就在于能不能撤销，所以这个承诺是**按 kind 声明、可查询**的，
而不是统一的。`deploy_status` 会报出来：

- **`atomic`**——一次操作即返回上一个 release，无中断、无重传。
- **`disruptive`**——可回滚，但激活流程重跑期间服务中断。
- **`unsupported`**——不承诺回滚；`deploy_rollback` 会拒绝并说明原因，
  且不发出任何远端命令。

驱动静态声明自己的等级，而**省略 `rollback` 就等于 `unsupported`**——注册表会拒绝
承诺与实现不一致的驱动，所以一个 kind 无法宣称自己有没写过的回滚能力。

## 阶段

`resolve → build → preflight → transfer → activate → verify → prune`

不是每个 kind 都用满这些阶段，但词汇是闭合的，所以跨 kind 的失败报告读起来一致。
每个失败都带上所属阶段、实际执行的命令、结束方式和输出尾部。

**`preflight` 是那条关键分界线**：在它之前（含）失败，远端分毫未动。直到
`activate` 为止，上一个 release 都还在服务——所以这期间的失败应当修好后重新部署，
而不是回滚。

## `static` kind

```
<remoteReleasesRoot>/<target>/<releaseId>/   载荷，不被服务
<remoteWebRoot>/<target>                     指向它的符号链接，被服务
```

`rsync` 把产物拷进一个**全新的** release 目录——不带 `--delete`，所以目标路径写错
也毁不掉任何东西，而且整个传输过程中上一个 release 保持原样。切换的做法是先建一个
新的符号链接、再把它重命名覆盖到在服务的那个上，这个重命名是原子的：访问者要么看到
旧 release，要么看到新的。

回滚就是同一个重命名反向做一次，这正是本 kind 属于 `atomic` 的原因。当前 release
和它的上一个永远不会被裁剪。

载荷放在被服务的目录树之外，而不是藏在里面，这样隔离性就不依赖你的 Web 服务器的
点文件规则。

**一次性配置：** 把 Web 服务器指向 `remoteWebRoot` 并让它跟随符号链接。本包不生成、
也不修改任何 Web 服务器配置。

**服务器需要 GNU coreutils**——原子切换用的是 `mv -T`。远端命令是 POSIX `sh`，
不支持 Windows 服务器。

## 已知边界

- 一个插件实例对应一台服务器。
- 假设部署是串行的；两个 agent 并发发布同一个 target 时，后切换的那个胜出。
- 裁剪失败会作为一条 warning 附在**成功**的部署上，而不是判定为失败。
- `entry` 只检查是否存在。站点是否**真的能用**归 skill 判断，不归工具。
