# @zhchxiao123/dsh-devflow-testenv

[English](README.md) | 中文

声明式测试环境：工作区根部的 `testenv.yml` 清单写明服务、就绪探针与测试命令；五个确定性工具——**`env_up`**、**`env_status`**、**`env_logs`**、**`env_down`**、**`env_test`**——在 [`ctx.subprocess`](https://www.npmjs.com/package/@deepseek-ai/dsh-subprocess) 之上执行它；捆绑的 **`testenv-bootstrap`** skill 负责清单的编写与修复。harness 的 `bash(run_in_background)` 已覆盖"单条后台命令 + tail + kill"——本插件为它表达不了的东西而存在：带就绪门的有序多服务拓扑、一次整环境拆除、以及每个 session 零重新考古；`env_test` 自己也接受同名 `run_in_background` 参数，让编排后的运行注册为一个 harness job，长套件不再因体验输给裸 shell。环境知识一次写进仓库、像任何文件一样走 review；失败解释归模型，因此插件是执行者，绝不是第二个编排器。

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
seed: pnpm run db:seed    # 可选；env_test 在 up 与 test 之间运行它
test: pnpm run test:integration         # 必填
evidence: test-results/**               # 可选；glob，指明红跑会在磁盘上留下什么
report:                                 # 可选；该次运行的机器可读报告
  path: test-results/report.json
  format: playwright-json
```

| 字段 | 含义 |
|---|---|
| `services[].name` | 唯一名字；`env_logs` 与失败报告都以它指名服务。 |
| `services[].up` | shell 启动命令。一条规则同时覆盖自退出型（`compose up -d`）与长驻型（`pnpm start`）：探针通过即就绪，无论进程是否还活着；进程在探针通过前失败则该服务失败；干净退出让探针继续轮询到就绪 deadline。 |
| `services[].ready` | `tcp`（连接打开）、`http`（GET 得到期望状态；仅接受绝对 `http://` URL，直连请求——绝不走代理）或 `command`（exit 0 即就绪，其他退出是"还没好"）三选一。 |
| `services[].down` | 可选停止命令，拆除时在 `Config.downTimeoutMs` 内先运行；无论如何随后都会终止 up 进程树。 |
| `services[].kind` | `'process'`（默认）。`'static'` 为未来静态预览托管**预留**：校验以专门的"预留未实现"错误拒绝它，区别于拼写错误得到的未知取值错误。 |
| `seed` / `test` | 顶层命令，`env_test` 在工作区根运行。 |
| `evidence` | 一个 glob 或一组 glob，相对工作区根，指明**红跑**会写出什么——截图、trace、video、日志。声明它们正是让它们可被检验的手段：红跑之后工具展开这些 glob 并报告命中了什么，**包括一个都没命中**，于是输出目录改名会当场暴露，而不是悄悄给出一份没有证据的失败报告。 |
| `report` | 测试命令自身运行的机器可读报告的 `path` 与 `format`。已实现的格式只有 `playwright-json`；JUnit XML 为何不在其中见下文的限制一节。 |

任一服务启动失败，`env_up` 返回前先把已启动服务按逆序回滚；失败服务的报告携带阶段、退出事实与日志尾。运行中的环境注册为插件 fiber 的一个 effect，其 disposer 就是整体拆除，因此 session 结束即拆除环境——孤儿服务进程在结构上被排除，而非靠清理代码。工作区根逐调用从调用方 agent 会话的工作目录解析（与 `dsh-devflow-tool` 派生自身根的逐调用来源相同），因此一个常驻 harness 可服务多个项目工作区，每个工作区有自己的引擎与环境；清单路径与每个服务的 `cwd` 都相对调用方的根解析，没有会话工作目录的调用 fail-loud，绝不回退到 harness 进程 cwd——常驻部署里它指向 harness 检出目录，而非任何工作区。工作目录指向同一工作区的多个会话共享该工作区的同一个引擎与其唯一环境：其中任一会话的 `env_down` 拆除的都是这份共享环境。

## 工具

| tool | 参数 | 线上值 |
|---|---|---|
| `env_up` | — | `{ ok, services: [{ name, state: ready\|failed\|not-started, probe?, readyAfterMs?, detail?, logTail? }], durationMs?, teardownDetail? }`；`durationMs` 是整次 up 尝试的毫秒耗时（含回滚），`readyAfterMs` 是从该服务 spawn 到就绪探针通过的毫秒数，`teardownDetail` 在把已启动服务拆回去这件事本身也失败时报告回滚自己的残留。 |
| `env_status` | — | 同一形状，但重新探测：每个就绪探针都再跑一次，因此答案是当下健康度，而非 `env_up` 曾经成功过；每条携带其 `probe` 种类与 `probeMs`——重跑的探针应答所花的毫秒数。环境未起时不含服务。 |
| `env_logs` | `service`、`fromOffset?` | `{ text, nextOffset, lossy }`——stderr 并入 stdout 的有界内存尾；把 `nextOffset` 传回来只读新增部分。服务进程退出后仍可读，直到拆除。 |
| `env_down` | — | `{ ok, detail? }`——逆启动序，先跑 `down` 命令，总是终止进程树；失败聚合进 `detail`，绝不中断后续服务的拆除。已 down 时幂等。 |
| `env_test` | `run_in_background?` | `{ passed, phase: up\|seed\|test, exitCode?, outputTail?, detail?, services?, envReused?, envUpAgeMs?, upDurationMs?, seedDurationMs?, testDurationMs?, durationMs? }`——环境未起先拉起，有 `seed` 则运行，再跑 `test`；报告指名定局的阶段，并携带逐阶段与整次运行的毫秒耗时；`envReused` 在本次运行复用了先前调用已拉起的环境时为 true，`envUpAgeMs` 是自那次拉起完成以来的毫秒数。之后环境保持运行以便重跑。清单声明了 `evidence` 或 `report` 的红色 test 阶段还会携带 `evidence`——失败的用例、找到的文件、以及收集过程中出的一切问题。`run_in_background: true` 时改为立即返回 `{ jobId }`——见下文。 |

长测试套件用 `env_test` 的 `run_in_background: true`：整条 up → seed → test 链注册为一个 `ctx.jobs` job（种类 `testenv-test`，归属调用 agent），调用立即返回 job id。`job_output` 流式给出阶段标记——逐服务的启动/就绪、seed 与 test 的起止——加上 test 进程的实时输出（对 `env_logs` 同款有界内存尾做 offset 增量读取，lossy 读取会明说），并以与同步调用完全相同的结论前置 render 收尾；`job_kill` 取消运行：终止当前阶段的进程树，并把本次运行自己拉起的环境拆回去（复用自先前 `env_up` 的环境保持运行，因为它归那次调用所有）。job 状态的映射是刻意的：跑完即定局的运行——测试红也算——是 `completed`，失败 render 就是它的 output；`killed` 是被取消的运行；`failed` 留给运行本身出故障（清单非法、引擎状态拒绝本次运行）。`ctx.jobs` 是可选 peer 服务，用 `ctx.get` 读取：组合里没有它时（加载 `@deepseek-ai/dsh-jobs-local` 加 `@deepseek-ai/dsh-tool-jobs`），后台调用 fail-loud，绝不静默降级为同步路径。

清单缺失或非法时，每次工具调用都变成 fail-loud 错误，逐条列出字段路径缺陷并指向 `testenv-bootstrap` skill。刻意不做失败归因：错误携带阶段、退出事实与日志尾，解释它们是模型的工作。读取类（`env_status`、`env_logs`）呈现为 `read` 类的 `generic` 卡；其余为 `execute` 卡。呈现器是参数的纯函数。

## 读懂一次失败的运行

红色的 `env_test` 先渲染失败的用例——每条带文件与位置、运行器给的消息、以及预渲染好的源码片段——然后是按路径列出的证据文件，最后是收集过程中出的问题。足够小、数量足够少的截图会作为图像块一同送达，模型可以直接看；其余是它可以自己打开的路径。`error.message` 到达时终端色码已被剥除，因为模型读到转义序列，看到的是环绕在有用文字周围的噪声。

图像的铸造发生在工具执行时，而非渲染时：工具的 render 是其规范值的纯同步函数，所以模型能看的那个引用必须先存在于该值中。引用以普通 JSON 传递，因为规范工具值必须是无损 JSON，而附件服务自己的引用两者皆非。

**附件服务是可选的，缺失时降级而不是失败。** `ctx.get('attachments')` 取不到时，每个文件仍以路径报告——这已是模型打开它所需的全部。这与 `ctx.jobs` 缺失时后台调用 fail-loud 是刻意不同的：要求后台运行的调用者会被一次同步运行误导，而读失败报告的调用者，在图像变成路径时并不丢失信息。降级本身写在值里——`image` 在则模型能看见，不在则它得去读路径——因此不需要用一个编造的理由去代表产生它的好几种原因（没有服务、媒体类型不可视、文件超过大小上限、配额用尽、后台 job 的输出是纯文本）。

两个上限都会报告自己丢弃了什么。`maxEvidenceImages` 有界，是因为 harness 在请求超预算时丢弃的是**最老**的图像，于是一次附带几十张截图的运行会挤掉对话中更早建立的图像；被截断的清单会说明找到了多少张、其余的以路径列出。

## 捆绑的 skill

`testenv-bootstrap`（捆绑，模型与用户均可调用，注册在 `BUNDLED_SKILL_RANK`，同层更低 rank 的 provider 可按名覆盖它）负责判断的那一半：考古项目服务怎么启动——CI 配置优先，因为通过的集成任务已经证明了它的命令——写出清单、证明它，清单腐烂时按工具的错误报告修复。正文是八节勘测协议：先枚举全部测试入口再选套件（单套件项目走快路径），逐套件查明服务绑定——全 mock 套件绝不作为 `test`——把淘汰记录与前置条件写进清单头注释，用 `env_up → env_status → env_down` 闭环证明它，再证伪（环境全停时 `test` 命令必须转红），并在会话中汇报勘测结论。

`testenv-author`（一同捆绑，调用面与 rank 相同）覆盖 bootstrap 服务不了的项目——尚无服务绑定的套件：它从代码证据推导服务绑定的测试方案——端到端或更窄，取决于代码给了什么——每个场景都锚定源文件，方案获用户批准后才写测试，再交回 bootstrap，其快路径随即选中这个新套件。

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
| `maxEvidenceImages` | `4` | 一次失败运行中随行的证据图像数量；其余以路径列出。 |
| `maxEvidenceFiles` | `50` | 一次失败运行中列出的证据文件总数，无论是否随行。 |
| `evidenceFileBytesCap` | `10485760` | 值得随行的单个证据文件的最大字节数。 |

## Model Experience

### Tool schemas

#### What the model sees

五个工具 schema，描述携带清单契约的后果：`env_up` 上的启动顺序与回滚、`env_status` 上的重新探测、`env_logs` 上的 offset 增量读取、`env_down` 上的聚合逆序拆除、`env_test` 上的 up → seed → test 阶梯——含把长套件引向 `run_in_background: true` 与 `job_output`/`job_kill` 衔接的引导——以及，在会加载清单的工具上，清单不存在时指向 `testenv-bootstrap` 的指引。结果遵循上文声明的输出 schema。

#### Token effect

插件激活期间每次请求固定的 schema 成本；结果以每流 `logTailBytes` 的尾部与逐服务报告行数为界。

#### KV Cache effect

插件作用域不变时前缀稳定；激活或卸载可能使工具 schema 段及其后的复用失效。

## Known Limitations and Deferred Work

- **每 session 一个环境** — 引擎同时至多持有一个运行中的环境；已起时再 `env_up` 是错误，不排队。并行多环境没有当前 owner。
- **不做依赖 DAG、并行启动、端口分配、单服务重启、自动重试** — 每项都因没有当前 owner 而排除，不是因为难；列表形态的清单让未来的 `dependsOn` 可增量加入。
- **`kind: static` 仅是 schema 预留** — 静态预览托管是未来工作；今天该取值是一个专门的校验错误。
- **不支持 `https` 就绪探测** — 本地就绪端点走明文，探测自签名开发证书会迫使一个没有当前 owner 需要的验证策略决定。
- **日志不跨拆除存续** — `env_logs` 读取的捕获输出只到 `env_down`（或 session 结束）为止；持久记录是服务自己写到磁盘的东西。证据文件不是日志：运行自己把它们写到了磁盘，因此失败报告点名的路径在拆除之后仍然可读。
- **JUnit XML 不是可选的 `report.format`** — 它是跨语言的交换格式，因此是显而易见的下一个，而它的缺席是刻意的。它携带用例名与消息，但没有附件、位置与源码片段——比 `evidence` glob 已经给出的还少——且它不是单一 schema 而是一族发射端方言，照着一份样本实现会给出兑现不了的承诺。目前没有消费者要它；第一个要它的人会连同多发射端的真实样本与 XML 解析依赖一起带来。
- **证据只在红色的 test 阶段收集** — 绿跑不报告证据，失败的 `up` 或 `seed` 阶段也不报告：没有测试运行可供解释。目前没有消费者要绿跑的 trace。
