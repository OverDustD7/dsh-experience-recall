# dsh-experience-recall

[English](README.md) ｜ DeepSeek Harness 插件（profile bundle）

[![npm](https://img.shields.io/npm/v/dsh-experience-recall)](https://www.npmjs.com/package/dsh-experience-recall)
[![ci](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.5-informational)](https://nodejs.org)

**模型在别的项目里学到的东西，它自己记不住。这个插件负责在合适的时机把它递回去。**

它盯着模型正在做的事——思考、工具调用、报错——一旦当前工作命中了记忆库里"别处已经学到过"的经验，就在下一步
开口之前把那条经验作为一条短消息插进去。全链路都在本地跑：词表、检索、相关性判定都用你自己的机器，检索和判定
默认不调用云端模型；注入的消息仍会占用宿主模型的上下文和输入 token。

## 插进去长什么样

下面是一条真实注入（截断过）：

```
【可能相关的历史经验 · 来自其他项目】
· 验证自研 DSH 宿主插件的一次性宿主法（不必重启 GUI、不碰 ~/.dsh）：把 DSH_HOME 指到 %TEMP% 里的临时 home，
  拷入 settings.yaml 与 .credentials.yaml，profile 的 dsh.profile.bundles 只写 [dsh-base, dsh-headless, 自研插件]，
  然后用 dsh --profile …（记忆 id: 0f5eddca）

需要细节：用 mnemon_recall / document_search 取全文。
```

卡片刻意压成一行、只留可复用的结论，并带记忆 id，模型想看全文可以自己去取。每回合最多几条，每条约 1.2 KB 以内。

## 它怎么工作

```
session/event（思考 · 正文 · 工具参数 · 工具结果 · 报错）
  → 机械关键词命中（词表由你的记忆自动派生，不花模型）        （免费）
  → 闸门：同回合同词一次 · 同记忆一次 · 冷却 · 每回合配额
  → 本地小模型判定"这条经验会不会改变我下一步的做法"          （串行，约 0.4 s）
  → 判定通过的结果在下一个 agent/pre-step 边界插入
```

边界**从不等待**：下一步开始时检索或判定还没好，这一步就照常走，卡片晚一步到。也**从不猜**——判定不确定或
输出不可解析，一律丢弃而不是硬插。

词表不是手写的：它由你的记忆库（作者写的 tags/entities + 正文里的专名）与项目文档派生，连每篇文档的 `##` 小节
都算，然后过滤掉"区分不了任何东西"的词。新记忆在 `mnemon_*` 工具调用后自动进表。

## 依赖

| 需要 | 作用 | 没有它会怎样 |
|---|---|---|
| DSH `>= 0.1.5-rc.1` | 宿主 | — |
| Node `>= 22.5`，推荐 24.x | 用 `node:sqlite` 只读记忆库；Node 22 上该模块需要 `--experimental-sqlite`，Node 23.4 起不再需要 | 插件仍能跑，但由记忆派生的词表为空（文档与种子词照常工作） |
| [dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) 与 `mnemon` CLI | 记忆索引与语义检索 | 缺 CLI 时，已有索引卡仍能命中；CLI 检索不可用 |
| 本地模型（Ollama，默认 `http://localhost:11434` 的 `qwen3.5:9b`） | 生成卡片 + 判相关性 | 会观察、会写日志，但**什么都不插**——它拒绝靠猜 |

## 安装

```sh
dsh plugin --profile web add dsh-experience-recall
```

`web` 是 DSH 网页界面用的那个 profile，你若改过名字就换成自己的。这条命令会把参数转交给你的包管理器，
所以仓库地址与本地检出处同样可以：

```sh
# 跟这个仓库走，而不是跟 npm 发布版
dsh plugin --profile web add github:OverDustD7/dsh-experience-recall

# 开发：装你正在改的那份检出处
dsh plugin --profile web add link:/path/to/dsh-experience-recall
```

然后重启 `dsh web`。安装本身已经把这个包加进 profile 的 `dsh.profile.bundles`，**不要再手工加一遍**，
否则 loader 会以 `duplicate loader entry id` 启动失败。

## 确认它在工作

- 聊天里输入 **`/experience-recall`**：打印词表规模、扫描与命中计数、判定通过·拒绝·未答（含平均耗时与重试
  次数）、注入次数、最近通过的那条。
- 看磁盘：`$DSH_HOME/dsh-experience-recall/logs/observe.ndjson` 里有 `trigger` / `recall`（带判定理由）/
  `verify` / `inject` / `term-cooldown`——"为什么插 / 为什么没插"永远查得到。判定记录还带
  `source`/`termKind`（词表哪一半产出的）与 `df`（这个词多普遍）。
- 装机自检：`node node_modules/dsh-experience-recall/tools/check-install.mjs`
  （挪过状态目录就加 `--cache` / `--log`）。

刚装好请先干几分钟活：首次启动会用本地模型给每条记忆建一张卡（几百条记忆约 5 分钟），建完之前词表很薄。

## 配置

全部可选，写在行的 `config` 里——可以改包内的 `cordis.patch.yml`，但更推荐写在**你自己的 profile 覆盖层**
`$DSH_HOME/profiles/<name>/cordis.patch.yml`（它优先级更高）：

```yaml
- id: experience-recall
  config:
    maxInjectionsPerTurn: 0     # 继续观察，什么都不插
    localModel: 'qwen3.5:9b'
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `stateDir` | `$DSH_HOME/dsh-experience-recall` | 日志与卡片缓存的位置 |
| `logPath` / `cardCachePath` | 在 `stateDir` 下 | 可单独覆盖；`cardCachePath: ''` 表示不要缓存 |
| `mnemonCliPath` | `$MNEMON_CLI_PATH` | `mnemon` CLI；`''` 仅关闭 CLI 检索 |
| `mnemonDataDir` / `mnemonStore` | `$MNEMON_DATA_DIR` 或 `$DSH_HOME/mnemon` / `$MNEMON_STORE` 或 `default` | 索引读取与 CLI 共用；未设 `DSH_HOME` 时使用 `~/.dsh` |
| `localModel` / `localEndpoint` | `qwen3.5:9b` / `http://localhost:11434` | 卡片生成 + 相关性判定 |
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

## 它写什么、花什么

- 只写状态，且都在 `stateDir` 下：`logs/observe.ndjson`（32 MB 轮转）与 `cache/cards.json`。
  不往 `node_modules` 里写东西，也不改你的任何文件。
- 检索和判定访问配置的端点，默认是 localhost，不含遥测。自定义端点会收到对应请求所需的上下文、卡片或嵌入查询。
  日志包含关键词上下文和注入卡片正文。判定器在本地 `node` 子进程运行。
- 上下文开销有上限：每回合最多 `maxInjectionsPerTurn` 个注入块，每块 ≤ `maxInjectBytes`，
  每块最多 `maxCardsPerInjection` 张卡；注入文本计入宿主模型输入 token。

## 卸载

```sh
dsh plugin --profile web remove dsh-experience-recall
```

然后重启。想连日志与缓存一起清掉，删 `$DSH_HOME/dsh-experience-recall/`。

## 排查

| 现象 | 多半是 |
|---|---|
| 从来不注入 | 检查存储路径、注入配额、模型名称和端点；判定器不可达会丢弃候选而不是硬插。内置种子词不依赖模型 |
| 日志里 `rejected` 很多、`inject` 很少 | 判定器会拒绝弱相关或不确定候选。`/experience-recall` 与 `term-cooldown` 可查词条信誉；未答不计入词条拒绝次数 |
| 重启后头几分钟什么都不插 | 本地模型正在加载。0.6.2 起超时的判定会用更长预算重试，而不是把这次加载取消掉 |
| 首次启动很慢 | 正在建卡片缓存（每条记忆一次本地模型调用）。可先手动预热：`node node_modules/dsh-experience-recall/tools/build-cards.mjs --cache <stateDir>/cache/cards.json` |
| 装完毫无反应 | 需要重启；查日志里的 `ready`，以及 `command-registered` / `system-prompt-section` / `token-meter` 三条挂载记录是否出现 |

## 开发

目录：

| 路径 | 里面是什么 |
|---|---|
| `lib/index.js` | 接线：按 agent 订阅 `session/event` 与 `agent/pre-step`、`/experience-recall` 命令、恒定系统提示段、token-meter |
| `lib/observer.js` · `lib/scan.js` | 把会话事件转成可扫描的文本段 |
| `lib/keywords.js` · `lib/table.js` · `lib/terms.js` | 词表：机械匹配、活词表、专名抽取与词形闸门 |
| `lib/cards.js` | 建卡（本地模型 + 机械兜底 + 文档切片）并负责磁盘缓存 |
| `lib/mnemon-store.js` · `lib/memory-watch.js` | 只读 `node:sqlite` 读记忆库，并做增量对账 |
| `lib/recall.js` | `mnemon` CLI 检索（硬超时、缓存、静默降级） |
| `lib/verify.js` · `tools/check-relevance.mjs` | 第二级相关性判定（串行、超时重试、未答退避） |
| `lib/controller.js` · `lib/render.js` · `lib/surface.js` | 闸门、队列与注入边界；渲染；可见性判据 |
| `tools/` | CLI 工具：`check-install`、`build-cards`、`term-audit`、`verdict-report`、`judge-probe`、`verify-package`，以及本地评测脚本 |
| `test/` | 124 项测试，跑在 node 自带 runner 上 |

命令（不需要 install：插件没有依赖）：

```sh
npm run check                            # 全部运行时模块语法检查
npm test                                 # 124 项单元测试，不联网
node tools/check-install.mjs             # 装机自检
node tools/verify-package.mjs            # 按 files 模拟发布包并体检
node tools/verdict-report.mjs            # 运行数据：来源通过率、分数分布、判定健康度
node tools/judge-probe.mjs --n 3         # 现场探判定器（真实端点）
```

`lib/config.js` 里的 `PLUGIN_VERSION` 与 `package.json` 保持一致；`prepack` 会跑语法检查与测试，坏包发不出去。
CI 在 Ubuntu 与 Windows 上用 Node 24 跑同样两条命令。

用于标定判定提示词的标注样本**不在本仓库**：它们取自作者的私人记忆摘录，所以 `tools/judge-ab.mjs`、
`tools/calibrate.mjs`、`tools/relevance-lab.mjs` 只存在于作者的检出处。运行、测试与打包这个插件所需的一切都在这里。

## 相关链接

- DeepSeek Harness —— 本插件运行的宿主
- [dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) —— 它读取的记忆库与 `mnemon` CLI
- [awesome-dsh-plugin](https://awesome-dsh-plugin.com) —— DSH 市场背后的精选列表；GitHub topic `dsh-plugin`

## 许可证

MIT
