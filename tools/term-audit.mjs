// Term-level audit of the trigger vocabulary in cache/cards.json.
//
// Answers the questions that decide whether the vocabulary is healthy:
//   * how stale revisions pile up in the cache (revision key = `<id>:<updatedAt>|<len>`);
//   * how many live cards have no usable term at all (they can never fire);
//   * how document frequency is distributed, and what a ubiquity cap would remove
//     at different ratios — measured on the live corpus, not on the staging batch.
//
// Read-only: prints numbers, writes nothing.
//
// Usage:
//   node tools/term-audit.mjs [--cache cache/cards.json] [--ratios 0.005,0.01,0.02]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT } from '../lib/config.js'
import { isUsableTerm } from '../lib/terms.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const cachePath = argOf('--cache', join(PLUGIN_ROOT, 'cache', 'cards.json'))
const ratios = String(argOf('--ratios', '0.005,0.01,0.02'))
  .split(',')
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value > 0)

/**
 * Stable identity of a card. Prefer the id stored IN the card: a revision is
 * `<updatedAt>|<length>` and an ISO timestamp contains colons, so deriving the id
 * by splitting the key is wrong (that mistake once deleted a whole cache).
 * The split is a legacy fallback only.
 */
export function baseIdOf(key, value) {
  const id = value?.id
  if (typeof id === 'string' && id !== '') return id
  const text = String(key)
  const cut = text.lastIndexOf(':')
  return cut < 0 ? text : text.slice(0, cut)
}

const cards = JSON.parse(readFileSync(cachePath, 'utf8'))?.cards ?? {}
const entries = Object.entries(cards)

// --- 1. stale revisions -------------------------------------------------------
const byBase = new Map()
for (const [key, card] of entries) {
  const base = baseIdOf(key, card)
  const list = byBase.get(base) ?? []
  list.push({ key, terms: Array.isArray(card?.terms) ? card.terms.length : 0 })
  byBase.set(base, list)
}
const stale = [...byBase.values()].filter((list) => list.length > 1)
const staleExtra = stale.reduce((total, list) => total + list.length - 1, 0)
console.log(`缓存 ${cachePath}`)
console.log(`条目 ${entries.length} 条 | 稳定 id ${byBase.size} 个 | 多修订 id ${stale.length} 个 | 陈旧修订条目 ${staleExtra} 条（占 ${((staleExtra / Math.max(1, entries.length)) * 100).toFixed(0)}%）`)
const missingId = entries.filter(([, card]) => typeof card?.id !== 'string' || card.id === '').length
if (missingId > 0) console.log(`注意：${missingId} 条卡片没有自带 id（旧版本写的），compact 对它一律保守处理（不判孤儿）`)

/** Keep only the newest revision per stable id, the way the runtime index does. */
function newestPerBase() {
  const picked = new Map()
  for (const [key, card] of entries) {
    const base = baseIdOf(key, card)
    const previous = picked.get(base)
    if (previous === undefined || String(key) > String(previous)) picked.set(base, key)
  }
  return picked
}
const newest = newestPerBase()
const liveCards = [...newest.values()].map((key) => cards[key])
console.log(`按「每个 id 只留最新修订」算，活动卡片 ${liveCards.length} 张`)

// --- 2. live cards without usable terms --------------------------------------
const zero = [...newest.entries()].filter(([, key]) => !Array.isArray(cards[key]?.terms) || cards[key].terms.length === 0)
console.log(`\n活动卡片中零触发词 ${zero.length} 张（占 ${((zero.length / Math.max(1, liveCards.length)) * 100).toFixed(0)}%，永远不可能被命中）`)
const zeroBySource = new Map()
for (const [, key] of zero) {
  const source = cards[key]?.source ?? '?'
  zeroBySource.set(source, (zeroBySource.get(source) ?? 0) + 1)
}
console.log(`  按来源：${[...zeroBySource.entries()].map(([key, value]) => `${key}=${value}`).join('，') || '（无）'}`)
for (const [base, key] of zero.slice(0, 8)) console.log(`  - ${base.slice(0, 46)}  ${String(cards[key]?.card ?? '').slice(0, 60)}`)

// --- 3. DF over live cards, and what each cap would remove -------------------
const df = new Map()
for (const [, key] of newest) {
  for (const term of new Set((cards[key]?.terms ?? []).map((item) => String(item).toLowerCase()))) df.set(term, (df.get(term) ?? 0) + 1)
}
const sorted = [...df.entries()].sort((a, b) => b[1] - a[1])
console.log(`\n活动语料去重触发词 ${df.size} 个；DF 分布：`)
const hist = new Map()
for (const [, count] of df) {
  const bucket = count === 1 ? '1' : count <= 2 ? '2' : count <= 4 ? '3-4' : count <= 8 ? '5-8' : count <= 16 ? '9-16' : count <= 32 ? '17-32' : '>32'
  hist.set(bucket, (hist.get(bucket) ?? 0) + 1)
}
for (const bucket of ['1', '2', '3-4', '5-8', '9-16', '17-32', '>32']) {
  if (hist.has(bucket)) console.log(`  DF=${bucket.padEnd(5)} ${String(hist.get(bucket)).padStart(5)} 个词`)
}
console.log(`  DF 最高的 10 个：${sorted.slice(0, 10).map(([term, value]) => `${term}(${value})`).join('，') || '（无）'}`)

console.log(`\n不同 ubiquity 比例下会被剔除的词（按活动卡片 ${liveCards.length} 张计算）：`)
for (const ratio of ratios) {
  const cap = Math.max(2, Math.floor(liveCards.length * ratio))
  const blocked = sorted.filter(([, count]) => count > cap)
  const termShare = ((blocked.length / Math.max(1, df.size)) * 100).toFixed(1)
  console.log(`  比例 ${(ratio * 100).toFixed(1)}% -> cap ${cap}：剔除 ${blocked.length} 个词（占 ${termShare}%）；样例 ${blocked.slice(0, 8).map(([term, value]) => `${term}(${value})`).join('，') || '（无）'}`)
}

// --- 4. what the tightened term rules removed from the live cache ------------
const weakened = [...df.keys()].filter((term) => !isUsableTerm(term))
console.log(`\n按当前词形规则，活动语料里仍不合格的词 ${weakened.length} 个（应被 revalidate 清掉）：${weakened.slice(0, 10).join('，') || '（无）'}`)

// --- 5. the judge's own term traffic, joined with document frequency --------
const logPath = argOf('--log', join(PLUGIN_ROOT, 'logs', 'observe.ndjson'))
let verdicts = []
try {
  verdicts = readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line)
        return record.kind === 'recall' && typeof record.term === 'string' ? [record] : []
      } catch {
        return []
      }
    })
} catch {
  verdicts = []
}
if (verdicts.length > 0) {
  const byTerm = new Map()
  for (const record of verdicts) {
    const term = String(record.term).toLowerCase()
    const entry = byTerm.get(term) ?? { accepted: 0, rejected: 0, dropped: 0 }
    if (record.phase === 'queued') entry.accepted += 1
    else if (record.phase === 'rejected') entry.rejected += 1
    else entry.dropped += 1
    byTerm.set(term, entry)
  }
  const rank = [...byTerm.entries()].sort((a, b) => b[1].rejected + b[1].accepted - (a[1].rejected + a[1].accepted))
  const accepted = rank.reduce((total, [, entry]) => total + entry.accepted, 0)
  const rejected = rank.reduce((total, [, entry]) => total + entry.rejected, 0)
  console.log(`\n运行时判定流量：${rank.length} 个词、${accepted + rejected} 次终局判定（通过 ${accepted} / 拒绝 ${rejected}，判定通过率 ${((accepted / Math.max(1, accepted + rejected)) * 100).toFixed(0)}%）`)
  console.log('  判定次数最多的 12 个词：')
  for (const [term, entry] of rank.slice(0, 12)) {
    console.log(`    ${String(entry.accepted + entry.rejected).padStart(3)} 次（通过 ${entry.accepted} / 拒绝 ${entry.rejected}）  DF=${df.get(term) ?? 0}  ${term}`)
  }
  const neverAccepted = rank.filter(([, entry]) => entry.accepted === 0 && entry.rejected >= 3)
  const wasted = neverAccepted.reduce((total, [, entry]) => total + entry.rejected, 0)
  console.log(`  从未通过且被拒 ≥3 次的词 ${neverAccepted.length} 个，合计白烧 ${wasted} 次判定：${neverAccepted.slice(0, 10).map(([term]) => term).join('，') || '（无）'}`)
}
