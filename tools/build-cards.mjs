// Build (or refresh) the derived card/term index outside the host.
//
// Doing this once from the command line means the plugin's startup reconcile
// finds a warm cache and only builds what changed — otherwise the first start
// after a code change spends ~8 minutes calling the local model for every
// memory while a session is running.
//
// Usage:
//   node tools/build-cards.mjs [--limit N] [--model NAME] [--mechanical] [--quiet]
//                              [--cache <path>]   # default: <plugin root>/cache/cards.json
import { existsSync } from 'node:fs'
import { createCardBuilder } from '../lib/cards.js'
import { resolveConfig } from '../lib/config.js'
import { createMemoryWatch } from '../lib/memory-watch.js'
import { createStoreReader, defaultStorePaths } from '../lib/mnemon-store.js'
import { createTermTable } from '../lib/table.js'
import { SEED_KEYWORDS } from '../lib/keywords.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const mechanical = args.includes('--mechanical')
const quiet = args.includes('--quiet')
const limit = Number(argOf('--limit', '0'))
const model = argOf('--model', '')
// Default to the cache beside the code (consistent with every other tool in this
// package and with a repo checkout). A PUBLISHED install keeps its state under
// $DSH_HOME; pass --cache <that path> to prebuild what the running plugin reads —
// the header below prints both so a mismatch is visible.
const cachePath = argOf('--cache', resolveConfig({}).cardCachePath)
if (limit > 0 && !args.includes('--cache')) throw new Error('--limit requires --cache pointing to a separate sample cache')
if (limit > 0 && existsSync(cachePath)) throw new Error('--limit requires a new sample cache path; existing caches are protected')

const config = resolveConfig({
  cardBuilder: mechanical ? 'mechanical' : 'local',
  ...(model === '' ? {} : { localModel: model }),
  ...(limit > 0 ? { maxMemories: limit } : {}),
})

const records = []
const logger = quiet ? { write: () => {} } : { write: (record) => records.push(record) }
const paths = defaultStorePaths(config)
const store = createStoreReader({ paths, limits: { insights: config.maxMemories, documents: config.maxMemories }, logger })
const builder = createCardBuilder({ config, logger, cachePath })
const table = createTermTable({ seedEntries: SEED_KEYWORDS, logger })
const watch = createMemoryWatch({ table, store, builder, logger, config })

console.log(`卡片构建：${builder.mode}${builder.mode === 'local' ? ` (${config.localModel} @ ${config.localEndpoint})` : ''}`)
console.log(`存储：${paths.dbPath}`)
console.log(`本次写入：${cachePath}`)
if (config.cardCachePath !== cachePath) console.log(`插件状态目录里的缓存：${config.cardCachePath}（要同步给运行中的插件，请加 --cache 指向它）`)
if (limit > 0) console.log(`限制：最多 ${limit} 条`)
console.log('开始（每条记忆一次模型调用，首次约 1–2 秒/条）…')

const started = Date.now()
const before = builder.stats()
await watch.reconcile('cli-build')
const elapsed = Date.now() - started
const after = builder.stats()
const snapshot = watch.snapshot()

console.log('\n=== 结果 ===')
console.log(`用时 ${(elapsed / 1000).toFixed(1)} s`)
console.log(`记忆 ${snapshot.memories} 条 | 文档 ${snapshot.documents} 条 | 词表 ${JSON.stringify(table.stats())}`)
console.log(`新增 ${snapshot.added} | 更新 ${snapshot.updated} | 删除 ${snapshot.removed} | 失败 ${snapshot.failures}`)
console.log(
  `模型调用 ${after.model - before.model} 次 | 机械回退 ${after.mechanical - before.mechanical} 次 | 模型失败 ${after.modelFailed - before.modelFailed} 次 | 缓存命中 ${after.cacheHits - before.cacheHits} 次`,
)
if (after.model - before.model > 0) {
  console.log(`模型平均 ${Math.round((after.modelMs - before.modelMs) / Math.max(1, after.model - before.model))} ms/条`)
}
if (snapshot.lastError !== undefined) console.log(`最后错误：${snapshot.lastError}`)
if (snapshot.failures > 0 || snapshot.lastError !== undefined) process.exitCode = 1

const samples = [...table.entries.values()].filter((entry) => entry.memoryId !== undefined).slice(0, 12)
console.log('\n=== 词表样例（来自记忆的）===')
for (const entry of samples) {
  console.log(`  ${entry.term}  [${entry.kind}/${entry.source}]  ${String(entry.excerpt ?? '').slice(0, 50)}`)
}
if (!quiet) {
  const reconciled = records.filter((record) => record.kind === 'terms' || record.kind === 'error')
  if (reconciled.length > 0) console.log(`\n日志记录 ${reconciled.length} 条（最近一条：${JSON.stringify(reconciled.at(-1)).slice(0, 200)}）`)
}
