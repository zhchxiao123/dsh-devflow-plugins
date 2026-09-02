# @zhchxiao123/dsh-devflow-testenv

[English](README.md) | 中文

声明式集成测试环境：工作区根部的 `testenv.yml` 清单写明服务、就绪探针与测试命令；五个确定性工具——**`env_up`**、**`env_status`**、**`env_logs`**、**`env_down`**、**`integration_test`**——在 [`ctx.subprocess`](https://www.npmjs.com/package/@deepseek-ai/dsh-subprocess) 之上执行它；捆绑的 **`testenv-bootstrap`** skill 负责清单的编写与修复。harness 的 `bash(run_in_background)` 已覆盖"单条后台命令 + tail + kill"——本插件为它表达不了的东西而存在：带就绪门的有序多服务拓扑、一次整环境拆除、以及每个 session 零重新考古。环境知识一次写进仓库、像任何文件一样走 review；失败解释归模型，因此插件是执行者，绝不是第二个编排器。

## 清单

`services` 是有序列表——声明顺序就是启动顺序，也是拆除顺序的倒序。每个服务在前一个服务的探针通过后才启动。整个文件一次性校验；所有缺陷一并报告，各带字段路径。

```yaml
services:                 # 有序列表；至少一个服务；name 唯一
  - name: db
    up: docker compose up -d postgres   # 必填；启动服务的 shell 命令
    ready:                # 必填；恰好一个探针：tcp、http 或 command
      tcp: { port: 5432 }               # host 可省，默认 127.0.0.1
    down: docker compose down           # 可选；缺省 → 终止 up 进程树
    env: { PGPORT: "5432" }             # 可选；叠加在洗净的父环境之上
    cwd: services/db                    # 可选；相对工作区根
    readyTimeoutMs: 60000               # 可选；默认 Config.defaultReadyTimeoutMs
  - name: api
    up: pnpm run start:test
    ready:
      http: { url: "http://127.0.0.1:3000/healthz" }  # status 可省，默认任意 2xx
seed: pnpm run db:seed    # 可选；integration_test 在 up 与 test 之间运行它
test: pnpm run test:integration         # 必填
```

| 字段 | 含义 |
|---|---|
| `services[].name` | 唯一名字；`env_logs` 与失败报告都以它指名服务。 |
| `services[].up` | shell 启动命令。一条规则同时覆盖自退出型（`compose up -d`）与长驻型（`pnpm start`）：探针通过即就绪，无论进程是否还活着；进程在探针通过前失败则该服务失败；干净退出让探针继续轮询到就绪 deadline。 |
| `services[].ready` | `tcp`（连接打开）、`http`（GET 得到期望状态；仅接受绝对 `http://` URL，直连请求——绝不走代理）或 `command`（exit 0 即就绪，其他退出是"还没好"）三选一。 |
| `services[].down` | 可选停止命令，拆除时在 `Config.downTimeoutMs` 内先运行；无论如何随后都会终止 up 进程树。 |
| `services[].kind` | `'process'`（默认）。`'static'` 为未来静态预览托管**预留**：校验以专门的"预留未实现"错误拒绝它，区别于拼写错误得到的未知取值错误。 |
| `seed` / `test` | 顶层命令，`integration_test` 在工作区根运行。 |

任一服务启动失败，`env_up` 返回前先把已启动服务按逆序回滚；失败服务的报告携带阶段、退出事实与日志尾。运行中的环境注册为插件 fiber 的一个 effect，其 disposer 就是整体拆除，因此 session 结束即拆除环境——孤儿服务进程在结构上被排除，而非靠清理代码。工作区根是插件 apply 时捕获的进程 cwd（与 `dsh-devflow-filesystem` 默认根依赖的同一假设）；清单路径与每个服务的 `cwd` 都相对它解析。

## 工具

| tool | 参数 | 线上值 |
|---|---|---|
| `env_up` | — | `{ ok, services: [{ name, state: ready\|failed\|not-started, probe?, readyAfterMs?, detail?, logTail? }], durationMs?, teardownDetail? }`；`durationMs` 是整次 up 尝试的毫秒耗时（含回滚），`readyAfterMs` 是从该服务 spawn 到就绪探针通过的毫秒数，`teardownDetail` 在把已启动服务拆回去这件事本身也失败时报告回滚自己的残留。 |
| `env_status` | — | 同一形状，但重新探测：每个就绪探针都再跑一次，因此答案是当下健康度，而非 `env_up` 曾经成功过；每条携带其 `probe` 种类与 `probeMs`——重跑的探针应答所花的毫秒数。环境未起时不含服务。 |
| `env_logs` | `service`、`fromOffset?` | `{ text, nextOffset, lossy }`——stderr 并入 stdout 的有界内存尾；把 `nextOffset` 传回来只读新增部分。服务进程退出后仍可读，直到拆除。 |
| `env_down` | — | `{ ok, detail? }`——逆启动序，先跑 `down` 命令，总是终止进程树；失败聚合进 `detail`，绝不中断后续服务的拆除。已 down 时幂等。 |
| `integration_test` | — | `{ passed, phase: up\|seed\|test, exitCode?, outputTail?, detail?, services?, envReused?, envUpAgeMs?, upDurationMs?, seedDurationMs?, testDurationMs?, durationMs? }`——环境未起先拉起，有 `seed` 则运行，再跑 `test`；报告指名定局的阶段，并携带逐阶段与整次运行的毫秒耗时；`envReused` 在本次运行复用了先前调用已拉起的环境时为 true，`envUpAgeMs` 是自那次拉起完成以来的毫秒数。之后环境保持运行以便重跑。 |

清单缺失或非法时，每次工具调用都变成 fail-loud 错误，逐条列出字段路径缺陷并指向 `testenv-bootstrap` skill。刻意不做失败归因：错误携带阶段、退出事实与日志尾，解释它们是模型的工作。读取类（`env_status`、`env_logs`）呈现为 `read` 类的 `generic` 卡；其余为 `execute` 卡。呈现器是参数的纯函数。

## bootstrap skill

`testenv-bootstrap`（捆绑，模型与用户均可调用，注册在 `BUNDLED_SKILL_RANK`，同层更低 rank 的 provider 可按名覆盖它）负责判断的那一半：考古项目服务怎么启动——CI 配置优先，因为通过的集成任务已经证明了它的命令——从最小清单写起，用 `env_up → env_status → env_down` 闭环证明它，清单腐烂时按工具的错误报告修复。

## 配置

清单是项目知识；执行它的所有部署相关取值是插件 `Config`，加载即校验。

| 字段 | 默认 | 含义 |
|---|---|---|
| `manifestPath` | `'testenv.yml'` | 清单路径，相对工作区根。 |
| `readyPollIntervalMs` | `500` | 就绪尝试之间的间隔。 |
| `defaultReadyTimeoutMs` | `60000` | 未自行声明的服务的就绪 deadline。 |
| `downTimeoutMs` | `30000` | `down` 命令以及等待被终止进程树退出的 deadline。 |
| `testTimeoutMs` | `600000` | seed 与 test 命令各自的 deadline。 |
| `logTailBytes` | `65536` | 每条捕获流的内存尾上限。 |
| `graceMs` | `5000` | 交给每次 spawn 的 SIGTERM→SIGKILL 升级宽限。 |

## Model Experience

### Tool schemas

#### What the model sees

五个工具 schema，描述携带清单契约的后果：`env_up` 上的启动顺序与回滚、`env_status` 上的重新探测、`env_logs` 上的 offset 增量读取、`env_down` 上的聚合逆序拆除、`integration_test` 上的 up → seed → test 阶梯，以及——在会加载清单的工具上——清单不存在时指向 `testenv-bootstrap` 的指引。结果遵循上文声明的输出 schema。

#### Token effect

插件激活期间每次请求固定的 schema 成本；结果以每流 `logTailBytes` 的尾部与逐服务报告行数为界。

#### KV Cache effect

插件作用域不变时前缀稳定；激活或卸载可能使工具 schema 段及其后的复用失效。

## Known Limitations and Deferred Work

- **每 session 一个环境** — 引擎同时至多持有一个运行中的环境；已起时再 `env_up` 是错误，不排队。并行多环境没有当前 owner。
- **不做依赖 DAG、并行启动、端口分配、单服务重启、自动重试** — 每项都因没有当前 owner 而排除，不是因为难；列表形态的清单让未来的 `dependsOn` 可增量加入。
- **`kind: static` 仅是 schema 预留** — 静态预览托管是未来工作；今天该取值是一个专门的校验错误。
- **不支持 `https` 就绪探测** — 本地就绪端点走明文，探测自签名开发证书会迫使一个没有当前 owner 需要的验证策略决定。
- **日志不跨拆除存续** — `env_logs` 读取的捕获输出只到 `env_down`（或 session 结束）为止；持久记录是服务自己写到磁盘的东西。
