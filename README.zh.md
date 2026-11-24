# dsh-experience-recall

[English](README.md) | 简体中文

[![npm version](https://img.shields.io/npm/v/dsh-experience-recall?style=flat)](https://www.npmjs.com/package/dsh-experience-recall)
[![CI](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-informational?style=flat)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat)](LICENSE)

**模型在别的项目里学到的东西，它自己记不住。这个插件负责在合适的时机把它递回去。**

它盯着模型正在做的事——思考、工具调用、报错——一旦当前工作命中了记忆库里「别处已经学到过」的经验，就在下一步
开口之前把那条经验作为一条短消息插进去。全链路都在本地跑：词表、检索、相关性判定都用你自己的机器，检索和判定
默认不调用云端模型；注入的消息仍会占用宿主模型的上下文和输入 token。

## 发布与维护状态

- 状态：维护中。
- 支持范围：DSH `>= 0.1.5-rc.1`；Node `>= 22.5`（推荐 24.x）；一个本地 Ollama 兼容端点，供判定器与建卡器使用。
- 不在支持范围：连不上本地模型的宿主——插件仍会观察并写日志，但**什么都不插**；其他模型提供方不是本项目验证过的配置。
- 当前版本：见上方 npm badge。仓库 tag 不随每次发布更新。

## 环境要求

| 需要 | 作用 | 没有它会怎样 |
|---|---|---|
| DSH `>= 0.1.5-rc.1` | 宿主 | — |
| Node `>= 22.5`，推荐 24.x | 用 `node:sqlite` 只读记忆库；Node 22.5–22.12 和 23.0–23.3 需要 `--experimental-sqlite`；22.x 自 22.13 起、23.x 自 23.4 起及后续主版本不再需要 | 插件仍能跑，但由记忆派生的词表为空（文档与种子词照常工作） |
| [dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) 与 `mnemon` CLI | 记忆索引与语义检索 | 缺 CLI 时，已有索引卡仍能命中；CLI 检索不可用 |
| 本地模型（Ollama，默认 `http://localhost:11434` 的 `mimo-v2.6:9b-q6_K`） | 生成卡片 + 判相关性 | 会观察、会写日志，但**什么都不插**——它拒绝靠猜 |

任何 Ollama 兼容端点都可以通过 `localEndpoint` 接入。放在 Ollama 前面的本地代理，只要它响应
`POST /api/chat` 就没问题；代理在繁忙时直接回 503 的，会被当成「判定未答」，而不是「可以插」的理由。

SQLite 启动参数的版本条件依据 [Node.js 官方模块历史](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html#sqlite)。这是文档规定的条件，并不表示已在本机逐一实测所有支持版本。

## 安装

### 推荐

```bash
dsh plugin --profile web add dsh-experience-recall
```

`web` 是 DSH 网页界面用的那个 profile，你若改过名字就换成自己的。这条命令会把参数转交给 profile 目录里的 pnpm。

成功信号：命令报告该包已添加；重启 `dsh web` 后，在会话里输入 `/experience-recall` 会打印一段状态，
而不是「未知命令」。

### 其他已验证方式

同一条命令也接受仓库地址与本地检出：

```bash
# 跟这个仓库走，而不是跟 npm 发布版
dsh plugin --profile web add github:OverDustD7/dsh-experience-recall

# 开发：装你正在改的那份检出处
dsh plugin --profile web add link:/path/to/dsh-experience-recall
```

安装本身已经把这个包加进 profile 的 `dsh.profile.bundles`，**不要再手工加一遍**，否则 loader 会以
`duplicate loader entry id` 启动失败。

## 快速使用

1. 用上面的命令安装，然后重启 `dsh web`。
2. 在会话里正常干几分钟活。
3. 输入 `/experience-recall`。

看到状态里扫描计数不为零，就说明它在工作；它还会报告判定通过、拒绝、未答各多少，含平均耗时与重试次数。
下一次你的工作命中库里的经验时，就会插进第一条。全新安装的首次启动会用本地模型给每条记忆建一张卡
（几百条记忆约 5 分钟），建完之前词表很薄。

跑起来之后可选：

```text
/experience-recall model                    # 列出本机模型并选择
/experience-recall model qwen3.6:35b-a3b    # 直接切到它，不弹卡
/experience-recall help                     # 子命令说明
```

选择卡会问一次本机 Ollama 装了哪些对话模型，向量模型（`bge-m3` 这类）不会被列出来。选中即生效：判定器与建卡器
都是每次调用现读这个值，并写回你的 profile 覆盖层，所以重启后仍然是它。已经建好的卡片沿用旧模型的结果。
名字写错也不会坏：本机没装时命令会明说，卡片退回机械建卡。

### 插进去长什么样

下面是注入格式的示意。卡片正文是为这份 README 编的，不取自任何真实记忆；`MEMORY_ID` 是占位符。

```text
【可能相关的历史经验 · 来自其他项目】
· 处理跨设备配置冲突时，先用只读副本比对两侧提交，再决定以哪一侧为准（记忆 id: MEMORY_ID）

需要细节：用 mnemon_recall / document_search 取全文。
```

卡片刻意压成一行、只留可复用的结论，并带记忆 id，模型想看全文可以自己去取。每回合最多几条，每条约 1.2 KB 以内。

## 配置、数据与权限

数据与权限摘要：

- 处理什么：DSH 会话事件，以及你的 mnemon 记忆库内容（经 `node:sqlite` 只读打开）。没有遥测、没有统计上报。
- 网络：默认只和本机端点通信（`http://localhost:11434`）。将 `localEndpoint` 指向远程端点后，它会收到建卡和判定所需的上下文与卡片文本。
  CLI 检索另用 `mnemonEmbedEndpoint` 配置的嵌入端点，向它发送嵌入查询。
- 存在哪里：`$DSH_HOME/dsh-experience-recall/` 下的 `logs/observe.ndjson`（32 MB 轮转）与
  `cache/cards.json`。日志包含关键词上下文与注入卡片的正文。不往 `node_modules` 里写东西。
- 会改哪些文件：`stateDir` 下它自己的状态；`/experience-recall model` 记录模型选择时会写你的 profile 覆盖层。
  记忆库不写入，你的其它文件也不改。
- 需要什么权限：不需要额外系统权限。需要对 mnemon 记忆库的读权限，以及对所配端点的网络访问。

下表全部可选，写在行的 `config` 里——可以改包内的 `cordis.patch.yml`，但更推荐写在**你自己的 profile 覆盖层**
`$DSH_HOME/profiles/{{PROFILE_NAME}}/cordis.patch.yml`（它优先级更高）：

```yaml
- id: experience-recall
  config:
    maxInjectionsPerTurn: 0                  # 继续观察，什么都不插
    localModel: 'mimo-v2.6:9b-q6_K'
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `stateDir` | `$DSH_HOME/dsh-experience-recall` | 日志与卡片缓存的位置 |
| `logPath` / `cardCachePath` | 在 `stateDir` 下 | 可单独覆盖；`cardCachePath: ''` 表示不要缓存 |
| `mnemonCliPath` | `$MNEMON_CLI_PATH` | `mnemon` CLI；`''` 仅关闭 CLI 检索 |
| `mnemonDataDir` / `mnemonStore` | `$MNEMON_DATA_DIR` 或 `$DSH_HOME/mnemon` / `$MNEMON_STORE` 或 `default` | 索引读取与 CLI 共用；未设 `DSH_HOME` 时使用 `~/.dsh` |
| `localModel` / `localEndpoint` | `mimo-v2.6:9b-q6_K` / `http://localhost:11434` | 卡片生成 + 相关性判定（`/experience-recall model` 改的就是它） |
| `modelListTimeoutMs` / `modelPickTimeoutMs` | `5000` / `300000` | 取本机模型列表的超时；选择卡等待用户选择的超时 |
| `cardBuilder` | `local` | 设 `mechanical` 则建卡不用模型 |
| `minScore` | `0.35` | 检索分数下限 |
| `maxInjectionsPerTurn` / `maxCardsPerInjection` / `maxInjectBytes` | `3` / `2` / `1200` | 注入预算 |
| `verifyEnabled` / `verifyTimeoutMs` / `verifyMinIntervalMs` | `true` / `6000` / `1200` | 相关性闸门 |
| `verifyRetryTimeoutMs` / `verifyRetryLimit` | `30000` / `1` | 本地模型完全没答时，用一次更长预算重试——在 Ollama 里中断会取消这次加载，用同样的短预算重试会把加载锁死 |
| `verifyBackoffBaseMs` / `verifyBackoffMaxMs` | `2000` / `30000` | 判定未答之后，下一次开始时间指数拉开（`base * 2^n`，有上限），不再每个候选烧一次调用 |
| `warmupAttempts` / `warmupRetryDelayMs` | `3` / `5000` | 启动时等本地模型就绪的尝试次数与间隔 |
| `documentFragments` / `fragmentChars` | `true` / `200` | 把每篇文档的 `##` 小节各自建成卡片 |
| `systemPromptNote` | `true` | 在系统提示里注册恒定说明段 |
| `reinjectTokenDistance` / `repeatToolLimit` / `repeatWindowSteps` | `20000` / `3` / `12` | 长会话判据：注入被遗忘的距离、重复摸索 |
| `termRejectLimit` / `termBlockCooldownMs` | `3` / `1800000` | 词条信誉：从未通过且被拒到这个次数就冷却 |

上下文开销有上限：每回合最多 `maxInjectionsPerTurn` 个注入块，每块 ≤ `maxInjectBytes`，每块最多
`maxCardsPerInjection` 张卡；注入文本计入宿主模型输入 token。

## 升级与卸载

再次执行安装命令即可升级，pnpm 会把依赖移到最新的已发布版本：

```bash
dsh plugin --profile web add dsh-experience-recall
```

要钉住某个版本，用 `dsh plugin --profile web add dsh-experience-recall@{{VERSION}}`。升级后重启 `dsh web`。
卡片缓存与日志在升级后保留；卡片提示词有变更时，下一次启动会重建卡片。

卸载：

```bash
dsh plugin --profile web remove dsh-experience-recall
```

然后重启。移除包不会删状态目录：想连日志与卡片缓存一起清掉，删 `$DSH_HOME/dsh-experience-recall/`。
除此之外没有持久数据；卡片在需要时会从记忆库重建。

## 已知限制与排错

真实限制：

- 判定需要本地模型。连不上端点就什么都不插；这个插件不是纯关键词注入器。
- 召回质量受你自己的记忆库限制，库稀疏，命中就稀疏。
- 全新安装后、或卡片提示词变更后的第一次启动，会花几分钟建卡。
- 注入文本会占用宿主上下文与输入 token；每回合预算就是唯一的闸门。
- 只读你自己的库。它不是安全工具，也不审查记忆内容本身。

| 现象 | 多半是 |
|---|---|
| 从来不注入 | 检查存储路径、注入配额、模型名称和端点；判定器不可达会丢弃候选而不是硬插。内置种子词不依赖模型 |
| 日志里 `rejected` 很多、`inject` 很少 | 判定器会拒绝弱相关或不确定候选。`/experience-recall` 与 `term-cooldown` 可查词条信誉；未答不计入词条拒绝次数 |
| 重启后头几分钟什么都不插 | 本地模型正在加载。0.6.2 起超时的判定会用更长预算重试，而不是把这次加载取消掉 |
| 首次启动很慢 | 正在建卡片缓存（每条记忆一次本地模型调用）。可先手动预热：`node node_modules/dsh-experience-recall/tools/build-cards.mjs --cache {{STATE_DIR}}/cache/cards.json` |
| 装完毫无反应 | 需要重启；查日志里的 `ready`，以及 `command-registered` / `system-prompt-section` / `token-meter` 三条挂载记录是否出现 |

装机自检会打印它查的位置与结果：

```bash
node node_modules/dsh-experience-recall/tools/check-install.mjs
```

挪过状态目录就加 `--cache` / `--log`。运行日志在 `$DSH_HOME/dsh-experience-recall/logs/observe.ndjson`，
`trigger` / `recall` / `verify` / `inject` / `term-cooldown` 回答「为什么插 / 为什么没插」。

## 开发与详细文档

```bash
npm run check                            # 全部运行时模块语法检查
npm test                                 # 单元测试，不联网
node tools/verify-package.mjs            # 按 files 模拟发布包并体检
```

不需要 install：插件没有运行时依赖。`lib/config.js` 里的 `PLUGIN_VERSION` 与 `package.json` 保持一致；
`prepack` 会跑语法检查与测试，坏包发不出去。CI 在 Ubuntu 与 Windows 上用 Node 24 跑同样两条命令。

目录、检索与判定链路、宿主兼容细节、日志字段都放在下面，所以这一页在 GitHub 与 npm 上都能独立读懂。

<details>
<summary>技术说明：链路、词表、重试、目录、日志字段</summary>

**链路。** 会话事件（思考、正文、工具参数、工具结果、报错）先与由记忆派生的词表做机械匹配，不花模型；
闸门再限制频次：同回合同词一次、同记忆一次、冷却、每回合配额。然后本地小模型判断这条经验会不会改变下一步
（串行，约 0.4 s），判定通过的结果在下一个 `agent/pre-step` 边界插入。

边界从不等待：下一步开始时检索或判定还没好，这一步照常走，卡片晚一步到。也从不猜——输出不可解析或判定
不确定，一律丢弃。

**词表。** 由记忆库（作者写的 tags/entities + 正文里的专名）与项目文档（连每篇文档的 `##` 小节）派生，
再按形状规则过滤：文件属性、存储列名、通用文件名、含 `=` 或 `:` 的、少于两个字母的一律拒；不是黑名单。
标题产不出可用词的文档根本不缓存。每条记忆一张卡：一句可复用的话 + 触发词，提示词版本变了会重建。

**判定重试与退避。** Ollama 在 HTTP 客户端断开时会取消模型加载，所以一到判定预算就 abort、紧接着再问，
会把正在等的加载反复掐断（曾一次连断 52 次）。现在超时判定用一次更长预算重试；判定未答之后，下一次开始时间
指数拉开。未答单独计数，不算进词条的拒绝次数。

**宿主兼容。** 注入消息带 DSH v4 的「生产者自有来源」`kind: "plugin:dsh-experience-recall"`；读取时同时识别
v4 之前的 `{ kind: "plugin", plugin }` 包装，所以旧会话记下的注入在可见性、去重、再注入距离与窗口扫描里
仍被当作插件消息，不会被误判成用户输入。

**目录。**

| 路径 | 里面是什么 |
|---|---|
| `lib/index.js` | 接线：按 agent 订阅 `session/event` 与 `agent/pre-step`、命令、恒定系统提示段、token-meter |
| `lib/models.js` · `lib/model-command.js` | `/experience-recall model`：列本机模型、排序、切换并写回 profile |
| `lib/observer.js` · `lib/scan.js` | 把会话事件转成可扫描的文本段 |
| `lib/keywords.js` · `lib/table.js` · `lib/terms.js` | 词表：匹配、活词表、抽取与词形闸门 |
| `lib/cards.js` | 建卡（本地模型 + 机械兜底 + 文档切片）并负责磁盘缓存 |
| `lib/mnemon-store.js` · `lib/memory-watch.js` | 只读记忆库并增量对账 |
| `lib/recall.js` | `mnemon` CLI 检索（硬超时、缓存、静默降级） |
| `lib/verify.js` · `tools/check-relevance.mjs` | 第二级相关性判定 |
| `lib/controller.js` · `lib/render.js` · `lib/surface.js` | 闸门、队列、注入边界、渲染、可见性 |
| `tools/` | CLI 工具：`check-install`、`build-cards`、`term-audit`、`verdict-report`、`judge-probe`、`verify-package` |
| `test/` | 跑在 node 自带 runner 上的测试 |

**日志字段。** `$DSH_HOME/dsh-experience-recall/logs/observe.ndjson` 记录 `trigger`（哪个词在哪命中）、
`recall`（阶段 `queued` / `scores` / `result` / `rejected` / `dropped`，拒绝时带判定理由）、
`verify`（`outcome: accepted | rejected | inconclusive | retry`、耗时、尝试次数、`source` / `termKind` 与 `df`）、
`inject`（真正进了消息的卡片与字节数）、`visibility`（卡片还在上下文里，或已漂得太远）。

</details>

用于标定判定提示词的标注样本**不在本仓库**：它们取自私人记忆摘录，所以 `tools/judge-ab.mjs`、
`tools/calibrate.mjs`、`tools/relevance-lab.mjs` 只存在于作者的检出处。运行、测试与打包这个插件所需的一切都在这里。

## 反馈与安全报告

- 问题与建议：[github.com/OverDustD7/dsh-experience-recall/issues](https://github.com/OverDustD7/dsh-experience-recall/issues)
- 安全：目前没有提供私密报告渠道。请勿在公开 issue 里贴凭证、记忆摘录或其它敏感内容；描述问题即可，等维护者
  打开私密通道后再补细节。

## 许可证与第三方说明

许可证：MIT，见 [LICENSE](LICENSE)。

本插件不打包、也不在运行时要求任何第三方代码。它对接 DSH、可选的
[dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) 记忆库与 CLI，以及本地 Ollama 端点；这些各自按其
许可证分发，需要单独安装。

宿主是 DeepSeek Harness。相关入口：
[dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) ·
[awesome-dsh-plugin](https://awesome-dsh-plugin.com)（GitHub topic `dsh-plugin`）。
