# 项目工作说明（AGENTS）

本文件给在本仓库里工作的 agent 用。公开 README 面向使用者；这里写发布前要核什么、哪些东西不能进仓库。
全局规范入口由上层负责引导，本文件不复制内部入口，也不记录本机路径。

## 本项目的检查与打包命令

无运行时依赖，不需要 `install`：

```bash
npm run check                            # 语法检查全部运行时模块
npm test                                 # 单元测试，不联网
node tools/check-install.mjs             # 装机自检（真实安装后才有意义）
node tools/verify-package.mjs            # 按 package.json 的 files 模拟发布包并体检
```

打包产物不要落在仓库里：

```bash
npm pack --pack-destination "$TMPDIR"    # 或 Windows 下的 %TEMP%
```

`prepack` 会自动跑 `npm run check && npm test`。候选包必须再用 `tar -tzf` 列一遍入口，确认没有治理私有材料、
审计材料、运行时状态（日志与缓存）、个人数据或调度材料。

## 进仓库的东西

- 可以提交：代码、测试、工具、`README*.md`、`CHANGELOG.md`、`LICENSE`、`cordis.patch.yml`、
  `package.json`、`.github/`、`AGENTS.md`、`docs/`。
- 不提交运行时状态：`logs/`、`cache/` 已在 `.gitignore`。
- 不提交带本机痕迹的文本：绝对路径、电脑用户名、主机名、内网地址、凭证、token。解释运行环境时用条件描述
  与 `{{NAME}}` 形式的占位符，不写具体盘符路径。
- 不提交真实记忆摘录、真实记忆 id 或记忆库副本。文档里的注入示例必须标为虚构，id 用占位符；测试夹具只用
  自造样本，标定用的标注对不在本仓库。
- `DEV_NOTES.md`、`HANDOFF.md`、`SPEC*.md`、`AUDIT_REPORT.md`、`DEVELOPMENT.md`、`SAMPLE-INJECTION.md`
  是开发记录，目前不在跟踪范围内；要公开需先按发布流程复核，不要顺手 `git add -f`。

## 数据处理（按实际行为写，不用绝对保证）

- 默认只与本机端点通信（`http://localhost:11434`）。将 `localEndpoint` 指向远程端点时，该端点会收到
  建卡和判定所需的上下文与卡片文本。CLI 检索使用单独配置的 `mnemonEmbedEndpoint`，向它发送嵌入查询。
- 插件会写自己的状态：日志与卡片缓存，默认在 `$DSH_HOME/dsh-experience-recall/` 下。
  `/experience-recall model` 会把选中的模型写回用户的 profile 覆盖层。
- 记忆库只读（`node:sqlite` 只读打开）：不写回、不改用户文件。
- 本地排查时不要打开或复制真实记忆库内容；需要看结构就用临时 `DSH_HOME` 和自造数据。
- 日志可能含关键词上下文与注入卡片正文；对外提供日志前先删掉这些片段。

## 详细技术说明

实现链路、词表来源、判定重试与日志字段写在 [docs/internals.md](docs/internals.md)。这是仓库内文档，
不随 npm 包发布，也不从 README 链接。

## 回滚

改动前把要动的文件复制到仓库外的备份位置（不要用 `git stash` 当唯一备份）。已有未提交修改的文件只能从本轮修改前备份恢复；下面的命令只适用于修改前干净的文件：

```bash
git restore -- {{PATH}}                  # 回到 HEAD 版本
```

或者用备份覆盖回工作树。不要用 `git reset --hard`、不要重写历史、不要强推；发布过的版本不作为回滚手段删除，
需要时按发布流程处理。版本号与 `package.json`、`lib/config.js` 的 `PLUGIN_VERSION` 必须同步改。
