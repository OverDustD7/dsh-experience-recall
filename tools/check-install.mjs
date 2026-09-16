// Install self-check for the resident form.
//
// The resident plugin depends on two things outside its own directory: a profile
// that references it, and local services (mnemon CLI, Ollama, the card cache).
// A path rename or a cross-device sync of ~/.dsh can silently break the first —
// this script says exactly which link is broken and how to restore it.
//
// Usage: node tools/check-install.mjs [--profile web]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLUGIN_NAME, PLUGIN_ROOT, resolveConfig } from '../lib/config.js'
import { defaultStorePaths } from '../lib/mnemon-store.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const profileName = argOf('--profile', 'web')
const resolved = resolveConfig({})
const profileDir = join(resolve(resolved.stateDir, '..'), 'profiles', profileName)
const results = []

function record(level, name, detail) {
  results.push({ level, name, detail })
}

function checkPluginDir() {
  const entry = join(PLUGIN_ROOT, 'lib', 'index.js')
  record(existsSync(entry) ? 'ok' : 'fail', '插件本体', existsSync(entry) ? PLUGIN_ROOT : `缺少 ${entry}`)
}

function checkProfile() {
  const packagePath = join(profileDir, 'package.json')
  if (!existsSync(packagePath)) {
    record('fail', `profile ${profileName}`, `找不到 ${packagePath}`)
    return
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  } catch (error) {
    record('fail', `profile ${profileName}`, `package.json 解析失败：${String(error?.message ?? error)}`)
    return
  }
  const dependency = pkg?.dependencies?.[PLUGIN_NAME]
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  record(dependency === undefined ? 'fail' : 'ok', 'profile 依赖声明', dependency ?? '缺少 dependencies 条目（重装：见 DEV_NOTES §4.7）')
  record(bundles.includes(PLUGIN_NAME) ? 'ok' : 'fail', 'profile bundles 列表', bundles.includes(PLUGIN_NAME) ? '已列出' : '缺少该 bundle（dsh web 不会装载它）')
}

function checkLink() {
  const linkPath = join(profileDir, 'node_modules', PLUGIN_NAME)
  if (!existsSync(linkPath)) {
    record('fail', 'profile 内链接', `缺少 ${linkPath}（需要 junction 指向插件目录）`)
    return
  }
  let target = linkPath
  try {
    target = resolve(linkPath, 'lib', 'index.js')
  } catch {
    target = linkPath
  }
  record(existsSync(target) ? 'ok' : 'fail', 'profile 内链接', existsSync(target) ? `${linkPath} → 可解析` : `${linkPath} 指向的目标不存在（跨设备同步后常见）`)
}

function checkCache() {
  // A repo checkout keeps the cache beside the code; an installed package keeps it
  // under $DSH_HOME (lib/config.js defaultStateDir). Prefer whichever exists, and
  // let --cache name it exactly.
  const explicit = argOf('--cache', '')
  const beside = join(PLUGIN_ROOT, 'cache', 'cards.json')
  const stateCache = resolveConfig({}).cardCachePath
  const cachePath = explicit !== '' ? explicit : existsSync(beside) ? beside : stateCache
  if (!existsSync(cachePath)) {
    record('warn', '卡片缓存', `不存在（${cachePath}）：启动时会现场重建（每条记忆一次本地模型调用，约 5 分钟）`)
    return
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    const keys = Object.keys(parsed?.cards ?? {})
    const documents = keys.filter((key) => key.startsWith('doc:')).length
    const ageHours = (Date.now() - statSync(cachePath).mtimeMs) / 3600000
    record('ok', '卡片缓存', `${keys.length} 张（文档相关 ${documents}）| 更新于 ${ageHours.toFixed(1)} 小时前 | ${cachePath}`)
  } catch (error) {
    record('warn', '卡片缓存', `无法解析，保护机制会拒绝覆盖；请备份后修复：${String(error?.message ?? error)}`)
  }
}

function checkTools() {
  const checker = join(PLUGIN_ROOT, 'tools', 'check-relevance.mjs')
  record(existsSync(checker) ? 'ok' : 'fail', '判定器脚本', existsSync(checker) ? checker : `缺少 ${checker}（判定会全部记为不确定并被丢弃）`)
  const builder = join(PLUGIN_ROOT, 'tools', 'build-cards.mjs')
  record(existsSync(builder) ? 'ok' : 'warn', '索引器脚本', existsSync(builder) ? builder : `缺少 ${builder}`)
}

function checkCli() {
  const cli = process.env.MNEMON_CLI_PATH ?? ''
  if (cli === '') {
    record('warn', 'mnemon CLI', '目录里没有 MNEMON_CLI_PATH；种子词检索会静默降级')
    return
  }
  record(existsSync(cli) ? 'ok' : 'fail', 'mnemon CLI', existsSync(cli) ? cli : `路径不存在：${cli}`)
}

function checkMnemonHome() {
  const { dbPath: db, documentsIndexPath: index } = defaultStorePaths(resolved)
  record(existsSync(db) ? 'ok' : 'fail', '记忆库', existsSync(db) ? db : `找不到 ${db}`)
  record(existsSync(index) ? 'ok' : 'warn', '文档索引', existsSync(index) ? index : `找不到 ${index}`)
}

function checkOllama() {
  return fetch(`${argOf('--endpoint', resolved.localEndpoint).replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) })
    .then(async (response) => {
      if (!response.ok) {
        record('warn', 'Ollama', `HTTP ${response.status}`)
        return
      }
      const payload = await response.json()
      const names = (payload?.models ?? []).map((item) => item.name)
      const model = argOf('--model', resolved.localModel)
      const hasJudge = names.includes(model)
      record(hasJudge ? 'ok' : 'warn', 'Ollama', `模型 ${names.join(', ') || '（空）'}${hasJudge ? '' : `：没有 ${model}，默认判定会拒绝注入`}`)
    })
    .catch((error) => record('warn', 'Ollama', `不可达：${String(error?.message ?? error)}`))
}

function checkLog() {
  const beside = join(PLUGIN_ROOT, 'logs')
  const stateLog = resolveConfig({}).logPath
  const explicit = argOf('--log', '')
  const dir = explicit !== '' ? resolve(explicit, '..') : existsSync(beside) ? beside : resolve(stateLog, '..')
  if (!existsSync(dir)) {
    record('warn', '日志目录', `还没有写过日志（${dir}）：插件可能尚未在本进程里处理过事件`)
    return
  }
  const files = readdirSync(dir).filter((name) => explicit !== '' ? resolve(dir, name) === resolve(explicit) : name.startsWith('observe'))
  record(files.length > 0 ? 'ok' : 'warn', '日志目录', `${files.join(', ') || '（空）'} | ${dir}`)
}

checkPluginDir()
checkProfile()
checkLink()
checkCache()
checkTools()
checkCli()
checkMnemonHome()
checkLog()
await checkOllama()

const icon = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' }
console.log(`经验召回 · 装机自检（profile ${profileName}）\n`)
for (const item of results) console.log(`${icon[item.level]}  ${item.name.padEnd(18)} ${item.detail}`)
const failures = results.filter((item) => item.level === 'fail')
console.log(`\n结论：${failures.length === 0 ? '装机完整' : `${failures.length} 项需要处理`}`)
if (failures.length > 0) {
  console.log(`请按失败项检查 ${profileDir} 的插件声明、安装文件和记忆库路径。`)
  process.exitCode = 1
}
