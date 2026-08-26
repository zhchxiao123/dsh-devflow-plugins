# @zhchxiao123/dsh-devflow-web

[English](README.md) | 中文

devflow 自持的浏览器通道：一个 Consumer，把 [`ctx.devflow`](../devflow/README.zh.md) 缝的读侧投影到 [`ctx.webServer`](../../host/webserver/README.zh.md) 上的一条带前缀 JSON 路由。看板经本插件而非任何框架自有的转发面拿到卡片，这正是 devflow 这套插件能装进一台原厂 harness 的原因——这里没有一样东西需要改动 harness 自己的包。

## 路由

一条前缀路由 `/devflow/api`，路径末段是方法名。前缀命名的是领域而不是 npm scope，因此把这些插件换个 scope 重新发布不是破坏性改名。

```
POST /devflow/api/<method>    { "sessionId": "...", "id": "..." }
  -> 200 { "ok": true, "value": ... } | { "ok": false, "error": "..." }
```

方法只有两个，而这张分发表就是这个面的全部：`list` 返回该会话的活跃卡片，`detail` 一次往返返回一张卡加它完整的解码 journal 与当前租约持有者。表里没有的末段根本没有路由（404），读只接受 POST（405），store 的写操作——`transition`、`create`、`claim`、`attachArtifact`、`archiveDone`——一个都不投影。卡片移动仍然只在模型工具面、`/devflow` 命令面与审批面上发生，这是 devflow 从第一份 PRD 起的三面分工；换通道不是放松它的理由。

请求体带的是查看方会话，除此之外不带任何决定读取范围的东西。host 把该会话的工作区解析成它的 devflow 根，因此浏览器既选不了也发不出根、cwd 或任何别的路径。不带会话就读 store 的默认根；未知会话、缺失卡片与不可读的 journal 一律以 `ok: false` 抵达——那是看板呈现为“没有看板”的既定答案，而不是传输故障。读取失败的原因留在 host 侧的日志里：store 的消息点名 devflow 根下的文件，而浏览器不该从一个答案里学到它本来就问不出来的路径。这个面自己判定的拒绝则带上原因，因为那描述的是调用方发了什么——未知方法、非 POST 的读，或超长、不可解析、不是对象的请求体（后三者在分发之前以 400 拒掉）。只有可信来源门答得赤裸，因此不可信的调用方学不到这条路由期待什么。

## 变更流

一个升级端点 `/devflow/ws`，走同一道门。host 监听 `devflow/card-created` 与 `devflow/stage-changed`，向每个已连接的浏览器发一帧：

```json
{ "type": "devflow/stage-changed" }
```

一帧只说明这台 host 的 devflow 里有东西动了，除此之外什么都不说。浏览器以经读取面重取来回应它，因此一帧永远不会变成与看板所呈现之物赛跑的第二个真相——也永远不会把一张卡漏进工作区里并没有它的页面，因为那次重取与其他每次读取一样按会话取值。通道是单向的：客户端只要发东西就以 1008 关闭，非法帧只掐掉它自己那条 socket，而处置会把端点、监听与每条在连 socket 一并带走。

## 可信来源门

每个请求都过 harness 施加于 `/api` 的同一条规则。这里重述它，是因为那份实现是 `@deepseek-ai/dsh-client-connection` 的包内私有，而本插件只依赖已发布的面。`Host` 必须是 loopback 或配置过的 `trustedHosts` 权威（DNS 重绑定防线——`Host` 是被重绑定的页面唯一伪造不了的头）；显式的跨站 fetch 标记一律拒绝；带上来的 `Origin` 必须恰好是本权威。`trustedHosts` 的每一项必须是规范形式的裸 `host` 或 `host:port`，在装载时断言，因此一个笔误会当场失败，而不是悄悄让授权落空或放宽。把它配成该部署 `/api` 门上的同一份值，否则看板会恰好在聊天不通的地方不通。

组合只需在 store 与 webserver 旁边加一行；不组合它的部署照常拥有工具面与命令面，只是没有 Web 看板。

```yaml
- id: devflow
  name: '@zhchxiao123/dsh-devflow-filesystem'
- id: devflow-web
  name: '@zhchxiao123/dsh-devflow-web'
```

## Model Experience

None, as this package answers a human's browser with card state and touches no prompt, message, schema, stream, or tool result. 模型自己看到的同一批卡片仍由 [`dsh-tool-devflow`](../tool-devflow/README.zh.md) 负责。

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **这个面只读，而且保持只读** —— 从浏览器发起审批或阶段移动需要它自己的一面，而不是在这里加一个写方法。
- **没有协议版本协商** —— host 与浏览器两半随同一个包版本发布，因此信封与帧都不带版本字段；哪天通道的寿命超过了这个前提，就需要补上。
- **帧不说明是哪个 root 动了** —— 每个已连接的浏览器在每次变更时都重取，这正是这些事件经框架转发面抵达看板时的行为。点名受影响的 root 可以让某个页面跳过一次重取，但浏览器手里没有 root 到页面的映射可用来跳过；缺的是那张映射，而不是帧里的字段。
- **`trustedHosts` 要配两遍** —— 这里一遍、harness 的 `/api` 门上一遍，因为这两条规则跨不过一个不导出它的包边界共用实现。只改其中一处的部署会得到一块拉不动的看板。
