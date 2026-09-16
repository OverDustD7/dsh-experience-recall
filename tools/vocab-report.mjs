// Vocabulary / noise report for the card cache.
//
// Question it answers: is the trigger vocabulary actually usable, and where does
// it produce noise? It reads cache/cards.json only and prints counts — no model
// calls, nothing is written. Companion to tools/calibrate.mjs, which looks at the
// judge's runtime verdicts; this one looks at the vocabulary itself.
//
// Usage:
//   node tools/vocab-report.mjs [--cache cache/cards.json] [--top 20]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, resolveConfig } from '../lib/config.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const cachePath = argOf('--cache', join(PLUGIN_ROOT, 'cache', 'cards.json'))
const top = Number(argOf('--top', '20'))
const config = resolveConfig({})

const cards = JSON.parse(readFileSync(cachePath, 'utf8'))?.cards ?? {}
const entries = Object.entries(cards)
const kindOf = (card) => {
  const source = card?.source ?? '?'
  if (source === 'document-fragment') return 'document-fragment'
  if (source === 'document') return 'document'
  if (source === 'mechanical') return 'memory-mechanical'
  return 'memory-model'
}
const byKind = new Map()
for (const [, card] of entries) byKind.set(kindOf(card), (byKind.get(kindOf(card)) ?? 0) + 1)

console.log(`缓存 ${cachePath}`)
console.log(`卡片 ${entries.length} 张：${[...byKind.entries()].map(([key, value]) => `${key}=${value}`).join('，')}`)

// --- terms per card, and cards that can never fire ---
const termCounts = entries.map(([, card]) => (Array.isArray(card?.terms) ? card.terms.length : 0))
const zero = entries.filter(([, card]) => !Array.isArray(card?.terms) || card.terms.length === 0)
const hist = new Map()
for (const count of termCounts) hist.set(count, (hist.get(count) ?? 0) + 1)
console.log(`\n每条触发词数分布：${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([key, value]) => `${key}词=${value}张`).join('，')}`)
console.log(`零触发词卡片 ${zero.length} 张（永远不可能被命中）`)
for (const [key, card] of zero.slice(0, 5)) console.log(`  - ${key.slice(0, 44)}  source=${card?.source ?? '?'}  card=${String(card?.card ?? '').slice(0, 70)}`)

// --- document frequency over all cards (the ubiquity denominator) ---
const df = new Map()
for (const [, card] of entries) {
  for (const term of new Set((card?.terms ?? []).map((item) => String(item).toLowerCase()))) df.set(term, (df.get(term) ?? 0) + 1)
}
const uniqueTerms = df.size
// `maxTermDocumentFrequency` is a share of the corpus, with a floor for small
// corpora (lib/config.js). Reported here so the policy is visible, not guessed.
const ratio = Number.isFinite(config.maxTermDocumentFrequency) ? config.maxTermDocumentFrequency : 0.02
const floor = Number.isFinite(config.ubiquityFloor) ? config.ubiquityFloor : 4
const cap = Math.max(floor, Math.floor(entries.length * ratio))
console.log(`\n去重触发词 ${uniqueTerms} 个；ubiquity 策略：DF > max(${floor}, ${(ratio * 100).toFixed(1)}% × ${entries.length}) = ${cap} 剔除`)
const dfBuckets = [
  ['DF=1', (value) => value === 1],
  [`DF=2`, (value) => value === 2],
  [`DF=3-${cap}`, (value) => value > 2 && value <= cap],
  [`DF>${cap}（会被剔除）`, (value) => value > cap],
]
for (const [label, test] of dfBuckets) {
  const terms = [...df.entries()].filter(([, value]) => test(value))
  const share = ((terms.length / Math.max(1, uniqueTerms)) * 100).toFixed(0)
  console.log(`  ${label.padEnd(20)} ${String(terms.length).padStart(5)} 个词（占 ${share}%）`)
}
const overCap = [...df.entries()].filter(([, value]) => value > cap).sort((a, b) => b[1] - a[1]).slice(0, top)
if (overCap.length > 0) {
  console.log(`\n超过阈值的词（按 DF 降序，前 ${overCap.length}）：`)
  for (const [term, value] of overCap) console.log(`  DF=${String(value).padStart(4)}  ${term}`)
}

// --- term shape: the filter is heuristic, so show what slipped through ---
const allTerms = [...df.keys()]
const lengths = allTerms.map((term) => term.length).sort((a, b) => a - b)
const pct = (q) => lengths[Math.min(lengths.length - 1, Math.floor(q * lengths.length))]
console.log(`\n词长分布：中位 ${pct(0.5)} 字 | p90 ${pct(0.9)} 字 | p99 ${pct(0.99)} 字 | 最长 ${lengths[lengths.length - 1]} 字`)
const tooLong = allTerms.filter((term) => term.length > 24).sort((a, b) => b.length - a.length)
console.log(`超过 24 字的词 ${tooLong.length} 个（卡片提示词要求 2–24 字，说明是机械兜底/切片带进来的）`)
for (const term of tooLong.slice(0, 8)) console.log(`  ${term.length} 字  ${term.slice(0, 80)}`)

// --- fragment-specific: duplicated prefix terms with the parent document ---
const fragments = entries.filter(([key]) => key.startsWith('doc:') && key.includes('#'))
const docs = entries.filter(([key]) => key.startsWith('doc:') && !key.includes('#'))
const docTerms = new Map(docs.map(([key, card]) => [String(card?.id ?? key).replace(/^doc:/, ''), new Set((card?.terms ?? []).map((term) => String(term).toLowerCase()))]))
let fragmentTerms = 0
let overlapping = 0
for (const [key, card] of fragments) {
  const id = key.slice(4, key.indexOf('#'))
  const parent = docTerms.get(id)
  for (const term of card?.terms ?? []) {
    fragmentTerms += 1
    if (parent?.has(String(term).toLowerCase())) overlapping += 1
  }
}
console.log(`\n文档切片 ${fragments.length} 张（父文档卡 ${docs.length} 张），切片触发词 ${fragmentTerms} 个`)
console.log(`与父文档卡重复的切片触发词 ${overlapping} 个（占 ${((overlapping / Math.max(1, fragmentTerms)) * 100).toFixed(0)}%）`)
const perDoc = new Map()
for (const [key] of fragments) {
  const id = key.slice(4, key.indexOf('#'))
  perDoc.set(id, (perDoc.get(id) ?? 0) + 1)
}
const perDocCounts = [...perDoc.values()].sort((a, b) => b - a)
console.log(`每篇文档切片数：最多 ${perDocCounts[0] ?? 0}，中位 ${perDocCounts[Math.floor(perDocCounts.length / 2)] ?? 0}，共 ${perDoc.size} 篇有切片`)
