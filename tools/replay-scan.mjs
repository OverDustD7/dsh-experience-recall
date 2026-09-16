// Offline dry run of the P1 observer over a real durable session log.
//
// This is the stage-P1 evidence generator: it feeds real events (reasoning, tool
// arguments, tool results, real failures) through the exact same lib modules the
// plugin uses inside the host, and reports what the mechanical layer sees.
//
// Usage:
//   node tools/replay-scan.mjs <session.v3.jsonl.zstd> [--examples N]
import { createObserver } from '../lib/observer.js'
import { decodeSessionLog, parseEvents } from './lib/session-log.mjs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/replay-scan.mjs <session.v3.jsonl.zstd> [--examples N]')
  process.exit(2)
}
const examplesArg = process.argv.indexOf('--examples')
const exampleCount = examplesArg === -1 ? 3 : Math.max(0, Number(process.argv[examplesArg + 1] ?? 3))

const { text, frames, bytes } = decodeSessionLog(file)
const { events, skipped } = parseEvents(text)

const records = []
const observer = createObserver({
  logger: { write: (record) => records.push(record), flush: () => Promise.resolve() },
  config: { statsEvery: Number.MAX_SAFE_INTEGER, contextChars: 60 },
})

const started = Date.now()
for (const event of events) observer.observe(event, { sessionId: 'replay' })
const elapsedMs = Date.now() - started

const snapshot = observer.snapshot()
const eventRecords = records.filter((record) => record.kind === 'event')
const timed = records.filter((record) => record.kind === 'timing').map((record) => record.toolMs).sort((a, b) => a - b)
const hitRecords = eventRecords.filter((record) => Array.isArray(record.hits) && record.hits.length > 0)

const kindChars = new Map()
const kindCount = new Map()
for (const record of eventRecords) {
  for (const segment of record.segments ?? []) {
    kindCount.set(segment.kind, (kindCount.get(segment.kind) ?? 0) + 1)
    kindChars.set(segment.kind, (kindChars.get(segment.kind) ?? 0) + segment.chars)
  }
}

const hitBySegmentKind = new Map()
for (const record of hitRecords) {
  const kinds = new Set((record.segments ?? []).map((segment) => segment.kind))
  for (const hit of record.hits) {
    const bucket = hitBySegmentKind.get(hit.kind) ?? new Map()
    bucket.set('events', (bucket.get('events') ?? 0) + 1)
    hitBySegmentKind.set(hit.kind, bucket)
  }
  void kinds
}

console.log('=== 日志 ===')
console.log(`文件 ${file}`)
console.log(`zstd 帧 ${frames} | 解压 ${(bytes / 1024 / 1024).toFixed(2)} MB | 事件 ${events.length} | 解析失败 ${skipped}`)
console.log(`机械扫描全部事件耗时 ${elapsedMs} ms（${(elapsedMs / Math.max(1, events.length)).toFixed(3)} ms/事件）`)

console.log('\n=== 扫描到的文本量（按 segment 类型）===')
for (const [kind, count] of [...kindCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(14)} ${String(count).padStart(6)} 段  ${String(kindChars.get(kind)).padStart(10)} 字符`)
}
console.log(`  合计 ${snapshot.segments} 段 / ${snapshot.chars} 字符 | 超长被截断 ${snapshot.truncated} 次 | 例外 ${snapshot.failures}`)

console.log('\n=== 关键词命中 ===')
console.log(`命中 ${snapshot.hits} 次，分布在 ${hitRecords.length} / ${eventRecords.length} 个含文本事件上（${((hitRecords.length / Math.max(1, eventRecords.length)) * 100).toFixed(1)}%）`)
const byTerm = Object.entries(snapshot.byTerm).sort((a, b) => b[1] - a[1])
if (byTerm.length === 0) console.log('  （无命中）')
for (const [term, count] of byTerm) {
  const kinds = new Set()
  for (const record of hitRecords) for (const hit of record.hits) if (hit.term === term) kinds.add(hit.kind)
  console.log(`  ${String(count).padStart(5)}  ${term.padEnd(24)} ${[...kinds].join(',')}`)
}
console.log('  按触发分类:', Object.fromEntries([...hitBySegmentKind.entries()].map(([key, value]) => [key, value.get('events')])))

console.log('\n=== 命中样例（机械上下文窗口）===')
let shown = 0
for (const record of hitRecords) {
  if (shown >= exampleCount) break
  const hit = record.hits[0]
  console.log(`  [${record.type} turn=${record.turn} step=${record.step}] ${hit.term} :: ${hit.context}`)
  shown += 1
}

console.log('\n=== 触发面分布（哪些事件类型带文本）===')
const withText = new Map()
for (const record of eventRecords) withText.set(record.type, (withText.get(record.type) ?? 0) + 1)
for (const [type, count] of [...withText.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(6)}  ${type}`)

console.log('\n=== tool/call -> tool/result 时延 ===')
if (timed.length === 0) console.log('  （无可配对样本）')
else {
  const pct = (q) => timed[Math.min(timed.length - 1, Math.floor(q * timed.length))]
  console.log(`  样本 ${timed.length} | 中位 ${pct(0.5)} ms | p90 ${pct(0.9)} ms | 最大 ${timed[timed.length - 1]} ms`)
  console.log(`  ≥400 ms（够藏下一次热态 recall 的） ${timed.filter((value) => value >= 400).length} 次 (${((timed.filter((value) => value >= 400).length / timed.length) * 100).toFixed(1)}%)`)
}
