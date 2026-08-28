# @zhchxiao123/dsh-devflow-artifact-gate

[English](README.md) | 中文

[`devflow/transition`](../devflow/README.zh.md) 瀑布上的产物契约策略：配置的边要求已登记的产物 kind，且每个必备 kind 的最新一份登记必须通过机械结构检查——配置的 frontmatter 字段齐备、配置的 `## ` 章节标题存在。本插件是 `ctx.devflow` 缝上的只读 Consumer；不写任何东西、只裁决一条瀑布，并把 kind 规格以服务发布出去，让生产者能按门禁将要检查的同一份规格来产出交付物。

## 行为

对带有 `edges` 表项的 `from->to` 边上的尝试，门禁读取移动中的卡片，逐个检查必备 kind 的最新一份登记——journal revision 最大的那条，即 `devflow_attach_artifact` 的 kind + content 形式所写；纯路径登记不带 kind，永不匹配。kind 没有任何登记、登记的文件磁盘上读不到、缺 frontmatter 块或字段、缺章节，各计一条缺陷，否决理由**一次性**全部列出（`<kind>: <what>`，点名文件），让一轮返工看到全部差距，而不是每次尝试挤出一条。同 kind 的旧登记是历史而非证据：最新一份结构完整就放行，无论它的前身长什么样。

没有 `edges` 表项的边不读卡片直接委派；全部检查通过的卡片原样委派——后续策略（命令门禁、审批）如同本插件不存在一样裁决。否决不是提交：卡片停在原处、revision 不变、不产生 journal 条目。

检查只做结构：字段存在且有值、章节标题以 `## <title>` 行存在（允许尾随空白）。标题下面的内容好不好，是另一层的问题。

## Config

```yaml
- id: devflow-artifact-gate
  name: '@zhchxiao123/dsh-devflow-artifact-gate'
  config:
    specs:
      prd:
        frontmatter: [card, kind, title]
      design:
        frontmatter: [card, kind, title]
        sections: [Approach, Compatibility]
    edges:
      'draft->designing': [prd]
      'designing->ready': [prd, design]
```

| 键 | 默认 | 含义 |
|---|---|---|
| `specs` | `{}` | 按产物 kind 的结构规格：`frontmatter` 是必须存在且有值的字段，`sections` 是必须出现的标题（不含 `## `）。两个列表都可省略；空列表等于省略，两者都没有的 kind 只要求被登记。 |
| `edges` | `{}` | 每条 `from->to` 边必备的产物 kind。没有表项——或列表为空——的边不设门禁。 |

配置错误加载即失败，并点名配置项：边键不是 `<from>-><to>` 已知位置名的形式（`blocked` 两端皆合法——恢复边也可以有契约）、边引用了 `specs` 未声明的 kind、kind 键不符合缝的 kind 语法（小写字母数字与连字符、字母数字开头）、`frontmatter`/`sections` 列表里有空白条目。

没有边引用的 kind 合法：它纯粹作为发布的规格存在，服务于有模板但不设门禁的交付物。

## kind 规格服务

校验后的 `specs`——规范化（空列表丢弃）并深冻结——以可选服务 `devflowArtifactSpecs` 发布。生产者用 `ctx.get('devflowArtifactSpecs')` 读取，把同一份字段与章节列表喂给写交付物的环节，模板与检查便不会漂移；服务随插件 fiber 一起消失。类型（`ArtifactKindSpec`、`ArtifactSpecs`）导出供 type-only 引用。

## Model Experience

None, as a contract veto reaches a model only through the devflow tools' rejection text; this plugin registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **瀑布顺序就是部署加载顺序**——这一机械层应排在更慢的层（命令门禁、审批、任何 agent 检查）之前，让缺产物在跑测试套件或打扰人之前就被否决。没有什么强制这个顺序；靠部署的行序。
- **只查结构，不查语义**——存在的字段可能装着胡话，存在的章节可能空洞无物；评判内容是另外的（agent 侧）一层，不是这里。
- **契约只看 journal 登记过的 kind**——绕过 `attachArtifact` 的 kind + content 形式直接写进卡片目录的交付物，对本门禁不存在，这是有意的：journal 是"交付了什么"的权威。
