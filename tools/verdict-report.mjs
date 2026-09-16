// Verdict / threshold report from real runtime evidence.
//
// The questions this answers, as data accumulates (no code change needed once it
// runs long enough):
//   * Where should `minScore` sit? The plugin records every retrieved row's score
//     (`recall phase=scores`), including the ones it discarded — before this, the
//     threshold had never once produced a `below-min-score` skip.
//   * Are the 700+ `##` document fragments earning their keep? Verdict records
//     carry `source`/`termKind`/`df`, so acceptance can be split by which half of
//     the vocabulary fired.
//   * How often does the judge say the window had nothing readable in it?
//
// Read-only: prints numbers, writes nothing. Companion to `tools/calibrate.mjs`
// (judge prompt A/B) and `tools/term-audit.mjs` (vocabulary shape).
//
// Usage:
//   node tools/verdict-report.mjs [--log logs/observe.ndjson] [--cache cache/cards.json]
//                                [--min-score 0.35] [--top 12]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, resolveConfig } from '../lib/config.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const config = resolveConfig({})
const logPath = argOf('--log', join(PLUGIN_ROOT, 'logs', 'observe.ndjson'))
const cachePath = argOf('--cache', join(PLUGIN_ROOT, 'cache', 'cards.json'))
const minScore = Number(argOf('--min-score', String(config.minScore ?? 0.35)))
const top = Math.max(1, Number(argOf('--top', '12')) || 12)

function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

const records = readJsonl(logPath)
const cards = (() => {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'))?.cards ?? {}
  } catch {
    return {}
  }
})()

// Document frequency over live cards, used to label each verdict with how
// discriminative its term is.
const df = new Map()
for (const card of Object.values(cards)) {
  for (const term of new Set((card?.terms ?? []).map((item) => String(item).toLowerCase()))) df.set(term, (df.get(term) ?? 0) + 1)
}
const cardCount = Math.max(1, Object.keys(cards).length)
const cap = Math.max(
  Number.isFinite(config.ubiquityFloor) ? config.ubiquityFloor : 4,
  Math.floor(cardCount * (Number.isFinite(config.maxTermDocumentFrequency) ? config.maxTermDocumentFrequency : 0.02)),
)

const pct = (value) => `${(value * 100).toFixed(1)}%`
const pad = (text, width) => String(text).padEnd(width)
const median = (sorted) => (sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)])
const percentile = (sorted, q) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])

console.log(`日志 ${logPath}`)
console.log(`记录 ${records.length} 条 | 缓存 ${cardCount} 张卡 | ubiquity cap ${cap} | minScore ${minScore}`)

// ---------------------------------------------------------------- 1. volume ---
const count = (predicate) => records.filter(predicate).length
const sessions = new Set(records.map((record) => record.session).filter((value) => typeof value === 'string'))
const injections = records.filter((record) => record.kind === 'inject' && Array.isArray(record.cards))
// An inconclusive judgement is logged as `phase: 'rejected'` for compatibility
// with records written before 0.6.2, and carries `inconclusive: true`. It is not a
// verdict — the judge never answered — so mixing it in corrupts both the
// acceptance rate and the per-source table. That is exactly how the 2026-09-16
// boot storm stayed misread as "the model is slow at 63 calls/hour".
const recalls = records.filter((record) => record.kind === 'recall' && (record.phase === 'queued' || record.phase === 'rejected'))
const unanswered = recalls.filter((record) => record.inconclusive === true)
const verdicts = recalls.filter((record) => record.inconclusive !== true)
console.log('\n=== 一、规模 ===')
console.log(`  会话 ${sessions.size} | 事件记录 ${count((r) => r.kind === 'event')} | 关键词命中 ${count((r) => r.kind === 'trigger')} 次触发`)
console.log(`  判定 ${verdicts.length} 次（通过 ${verdicts.filter((r) => r.phase === 'queued').length} / 拒绝 ${verdicts.filter((r) => r.phase === 'rejected').length} / 不确定 ${unanswered.length}）`)
if (unanswered.length === 0 && recalls.length > 0) console.log('  （不确定为 0：0.6.2 之前的旧记录没有该标记，无法回填区分）')
console.log(`  注入 ${injections.length} 次 / ${injections.reduce((sum, r) => sum + (Array.isArray(r.cards) ? r.cards.length : 0), 0)} 张 / ${injections.reduce((sum, r) => sum + (Number.isFinite(r.bytes) ? r.bytes : 0), 0)} B`)
console.log(`  不可读窗口报告 ${count((r) => r.kind === 'recall' && r.phase === 'unreadable-window')} 次`)
console.log(`  错误 ${count((r) => r.kind === 'error')} 条`)

// ------------------------------------------------------ 2. advice by source ---
console.log('\n=== 二、判定按来源（切片值不值的直接答案）===')
const bySource = new Map()
for (const record of verdicts) {
  const key = record.source ?? record.termKind ?? '(无来源字段:旧记录)'
  const entry = bySource.get(key) ?? { accepted: 0, rejected: 0 }
  if (record.phase === 'queued') entry.accepted += 1
  else entry.rejected += 1
  bySource.set(key, entry)
}
if (bySource.size === 0) console.log('  （还没有带来源的判定记录）')
for (const [key, entry] of [...bySource.entries()].sort((a, b) => b[1].accepted + b[1].rejected - (a[1].accepted + a[1].rejected))) {
  const total = entry.accepted + entry.rejected
  console.log(`  ${pad(key, 28)} 判定 ${String(total).padStart(4)} | 通过 ${String(entry.accepted).padStart(3)} | 拒绝 ${String(entry.rejected).padStart(3)} | 通过率 ${total === 0 ? '-' : pct(entry.accepted / total)}`)
}

// ------------------------------------------------------ 3. rejected terms ----
console.log('\n=== 三、词条信誉（哪些词在白烧判定）===')
const perTerm = new Map()
for (const record of verdicts) {
  const term = String(record.term ?? '').toLowerCase()
  if (term === '' || term === '语义兜底' || term === '重复摸索兜底') continue
  const entry = perTerm.get(term) ?? { accepted: 0, rejected: 0 }
  if (record.phase === 'queued') entry.accepted += 1
  else entry.rejected += 1
  perTerm.set(term, entry)
}
const neverAccepted = [...perTerm.entries()].filter(([, entry]) => entry.accepted === 0 && entry.rejected >= 3).sort((a, b) => b[1].rejected - a[1].rejected)
const wasted = neverAccepted.reduce((sum, [, entry]) => sum + entry.rejected, 0)
console.log(`  从未通过且被拒 ≥3 次的词 ${neverAccepted.length} 个，白烧 ${wasted} 次判定（冷却阈值 ${config.termRejectLimit ?? 3} 次）`)
for (const [term, entry] of neverAccepted.slice(0, top)) console.log(`    拒 ${String(entry.rejected).padStart(3)} 次  DF=${String(df.get(term) ?? 0).padStart(3)}  ${term}`)
const passed = [...perTerm.entries()].filter(([, entry]) => entry.accepted > 0).sort((a, b) => b[1].accepted - a[1].accepted)
console.log(`  通过过的词 ${passed.length} 个，前 ${Math.min(top, passed.length)} 个：`)
for (const [term, entry] of passed.slice(0, top)) console.log(`    通过 ${String(entry.accepted).padStart(3)} / 拒 ${String(entry.rejected).padStart(3)}  DF=${String(df.get(term) ?? 0).padStart(3)}  ${term}`)

// -------------------------------------------------------------- 4. scores ----
console.log('\n=== 四、检索分数分布（minScore 该定多少）===')
const scoreRecords = records.filter((record) => record.kind === 'recall' && record.phase === 'scores' && Array.isArray(record.scores))
const scored = []
for (const record of scoreRecords) for (const value of record.scores) if (Number.isFinite(value)) scored.push(value)
const sorted = scored.slice().sort((a, b) => a - b)
if (sorted.length === 0) {
  console.log('  （还没有分数记录：需要至少一次走 CLI 的检索；直接命中衍生词的候选不经过 CLI，因此没有分数）')
} else {
  console.log(`  ${scoreRecords.length} 次检索共 ${sorted.length} 行分数：min ${sorted[0].toFixed(3)} | 中位 ${median(sorted).toFixed(3)} | p90 ${percentile(sorted, 0.9).toFixed(3)} | max ${sorted.at(-1).toFixed(3)}`)
  const buckets = [
    ['< 0.30', (v) => v < 0.3],
    ['0.30–0.35', (v) => v >= 0.3 && v < 0.35],
    ['0.35–0.45', (v) => v >= 0.35 && v < 0.45],
    ['0.45–0.60', (v) => v >= 0.45 && v < 0.6],
    ['≥ 0.60', (v) => v >= 0.6],
  ]
  for (const [label, test] of buckets) {
    const rows = sorted.filter(test)
    console.log(`    ${pad(label, 12)} ${String(rows.length).padStart(4)} 行  ${((rows.length / sorted.length) * 100).toFixed(0)}%`)
  }
  const below = sorted.filter((value) => value < minScore).length
  console.log(`  低于当前 minScore(${minScore}) 的行：${below}/${sorted.length}（${pct(below / sorted.length)}）`)
  console.log(`  被判定器最终采纳的分数：${verdicts.filter((r) => r.phase === 'queued' && Number.isFinite(r.card?.score)).map((r) => r.card.score).join('，') || '（直接命中衍生词的候选没有分数）'}`)
  if (sorted.length < 30) console.log('  样本还小（<30 行），先别据此改阈值；这里只记录分布。')
}

// --------------------------------------------------------- 5. injections -----
console.log('\n=== 五、注入与闸门 ===')
const skipTally = new Map()
for (const record of records) {
  if (record.kind !== 'stopped' || record.controller?.skipped === undefined) continue
  for (const [key, value] of Object.entries(record.controller.skipped)) skipTally.set(key, (skipTally.get(key) ?? 0) + value)
}
for (const [key, value] of [...skipTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(value).padStart(6)}  ${key}`)
const injectedIds = new Map()
for (const record of injections) for (const card of record.cards) injectedIds.set(String(card.id).slice(0, 12), (injectedIds.get(String(card.id).slice(0, 12)) ?? 0) + 1)
console.log(`  注入过的卡片种类 ${injectedIds.size}，其中文档/切片 ${[...injectedIds.keys()].filter((key) => key.startsWith('doc:')).length} 种`)

// ------------------------------------------------------- 6. judge health -----
// The question this answers: is the local model answering at all? A judgement the
// model never answered is not a rejection, and on 2026-09-16 the distinction was
// the whole incident: 78 of 85 unanswered calls happened in the first 7 minutes
// after a host start, because every abort cancelled the model load it was waiting
// for (Ollama log: 52 loads aborted by client disconnect).
console.log('\n=== 六、判定健康度（本地小模型答不答得上来）===')
const verifyRecords = records.filter((record) => record.kind === 'verify')
if (verifyRecords.length === 0) console.log('  （还没有 verify 记录）')
const outcomeLabels = ['accepted', 'rejected', 'inconclusive', 'retry', 'error']
for (const outcome of outcomeLabels) {
  const rows = verifyRecords.filter((record) => (record.outcome ?? '') === outcome)
  if (rows.length === 0) continue
  const ms = rows.map((record) => record.ms).filter(Number.isFinite).sort((a, b) => a - b)
  console.log(`  ${pad(outcome, 14)} ${String(rows.length).padStart(5)}  中位 ${String(median(ms)).padStart(5)} ms  p90 ${String(percentile(ms, 0.9)).padStart(5)} ms`)
}
const inconclusiveCalls = verifyRecords.filter((record) => record.outcome === 'inconclusive')
if (inconclusiveCalls.length > 0) {
  const fast = inconclusiveCalls.filter((record) => (record.ms ?? 0) < 1000).length
  const slow = inconclusiveCalls.filter((record) => (record.ms ?? 0) >= 5000).length
  console.log(`  不确定形态：快失败(<1s，连不上/请求错) ${fast}｜慢失败(≥5s，模型没答完) ${slow}｜其它 ${inconclusiveCalls.length - fast - slow}`)
  const reasons = new Map()
  for (const record of inconclusiveCalls) {
    const key = String(record.error ?? (record.raw === undefined ? '(无 error/raw)' : `unparsable: ${String(record.raw).slice(0, 50)}`)).slice(0, 70)
    reasons.set(key, (reasons.get(key) ?? 0) + 1)
  }
  for (const [key, total] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`    ${String(total).padStart(4)}  ${key}`)
  const lastReady = [...records].reverse().find((record) => record.kind === 'ready')
  if (lastReady !== undefined) {
    const start = Date.parse(lastReady.t ?? '')
    const bootWindowMs = 10 * 60000
    const at = (record) => Date.parse(record.t ?? '')
    const before = inconclusiveCalls.filter((record) => at(record) < start).length
    const inBoot = inconclusiveCalls.filter((record) => at(record) >= start && at(record) < start + bootWindowMs).length
    const after = inconclusiveCalls.length - before - inBoot
    console.log(
      `  本实例启动前 ${before} 次 | 启动后 10 分钟内 ${inBoot} 次 | 之后 ${after} 次` +
        `（启动期多为冷加载；0.6.2 起超时会先带一次更长预算的重试，不再逐条取消加载）`,
    )
  }
}
