// Probe a durable DSH session log (zstd-compressed NDJSON) to learn the exact
// event envelope shapes the experience-recall plugin will read at runtime.
// Usage: node tools/probe-session-log.mjs "<path to session.v3.jsonl.zstd>"
import { decodeSessionLog } from './lib/session-log.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/probe-session-log.mjs <session.v3.jsonl.zstd>')
  process.exit(2)
}

const { text, frames } = decodeSessionLog(file)
console.log('=== 解码 zstd 帧数 ===', frames)
const lines = text.split('\n').filter((line) => line.trim() !== '')

const typeCounts = new Map()
const samples = new Map()
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    typeCounts.set('<unparsable>', (typeCounts.get('<unparsable>') ?? 0) + 1)
    continue
  }
  const type = String(record.type ?? record.kind ?? '<no-type>')
  typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
  if (!samples.has(type)) samples.set(type, record)
}

console.log('=== 总行数 ===', lines.length, '| 解压后字节', Buffer.byteLength(text))
console.log('=== 事件类型计数 ===')
for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(6), type)
}

/** Describe an object shallowly without dumping live data wholesale. */
function shape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.length} x ${shape(value[0], depth + 1)}]`
  }
  if (typeof value !== 'object') return typeof value
  const keys = Object.keys(value)
  if (depth >= 3) return `{${keys.join(', ')}}`
  return `{ ${keys.map((key) => `${key}: ${shape(value[key], depth + 1)}`).join(', ')} }`
}

for (const type of ['turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end']) {
  const record = samples.get(type)
  console.log(`\n=== 样例 ${type} ===`)
  if (record === undefined) {
    console.log('(本日志中未出现)')
    continue
  }
  console.log('顶层键:', Object.keys(record).join(', '))
  console.log('形状:', shape(record))
}

// Reasoning visibility: the decisive question for the plugin's scan surface.
const assistant = samples.get('assistant/message')
if (assistant !== undefined) {
  const stream = assistant.data?.stream
  console.log('\n=== reasoning 可见性 ===')
  console.log('stream 是数组:', Array.isArray(stream), '| 长度:', Array.isArray(stream) ? stream.length : 'n/a')
  if (Array.isArray(stream)) {
    const streamTypes = new Map()
    for (const item of stream) streamTypes.set(item?.type, (streamTypes.get(item?.type) ?? 0) + 1)
    console.log('stream 记录类型计数:', [...streamTypes.entries()].map(([k, v]) => `${k}=${v}`).join(', '))
    for (const item of stream) {
      if (item?.type === 'reasoning-chunks' && Array.isArray(item.texts) && item.texts.length > 0) {
        console.log('reasoning 样例前 120 字:', String(item.texts[0]).slice(0, 120).replace(/\s+/g, ' '))
        break
      }
    }
  }
  const content = assistant.data?.message?.content
  if (Array.isArray(content)) {
    console.log('message.content 块类型:', content.map((block) => block?.type).join(', '))
  }
  console.log('message 键:', assistant.data?.message === undefined ? '(无 message)' : Object.keys(assistant.data.message).join(', '))
}

// Which assistant/message events actually carry reasoning text, and how much.
let withReasoning = 0
let withText = 0
const samplesWithReasoning = []
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.type !== 'assistant/message') continue
  const stream = record.data?.stream
  if (Array.isArray(stream) && stream.some((item) => item?.type === 'reasoning-chunks' && Array.isArray(item.texts) && item.texts.length > 0)) {
    withReasoning += 1
    if (samplesWithReasoning.length < 2) {
      samplesWithReasoning.push((stream.find((item) => item?.type === 'reasoning-chunks' && item.texts.length > 0).texts.join('')).slice(0, 200).replace(/\s+/g, ' '))
    }
  }
  if (Array.isArray(record.data?.message?.content) && record.data.message.content.some((block) => block?.type === 'text')) withText += 1
}
console.log('\nassistant/message 总数:', typeCounts.get('assistant/message') ?? 0, '| 带 reasoning 文本:', withReasoning, '| 带正文 text:', withText)
for (const sample of samplesWithReasoning) console.log('  reasoning 摘录:', sample)

// Timing evidence for the "trigger early, overlap with tool execution" design:
// how long sits between a tool/call event and its matching tool/result event.
console.log('\n=== tool/call -> tool/result 时延（毫秒）===')
const callTimes = new Map()
const deltas = []
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.type === 'tool/call') {
    callTimes.set(record.data?.callId, { time: record.time, name: record.data?.name, hasArguments: typeof record.data?.arguments === 'string' && record.data.arguments.length > 0 })
  } else if (record.type === 'tool/result') {
    const call = callTimes.get(record.data?.message?.source?.callId)
    if (call === undefined) continue
    deltas.push({ name: call.name, deltaMs: record.time - call.time, hasArguments: call.hasArguments })
  }
}
deltas.sort((a, b) => b.deltaMs - a.deltaMs)
for (const entry of deltas.slice(0, 10)) console.log(`  ${String(entry.deltaMs).padStart(8)} ms  ${entry.name}  arguments=${entry.hasArguments ? 'yes' : 'NO'}`)
if (deltas.length > 0) {
  const values = deltas.map((entry) => entry.deltaMs)
  console.log(`  样本 ${values.length} 个 | 中位 ${values.sort((a, b) => a - b)[Math.floor(values.length / 2)]} ms | 最大 ${values[values.length - 1]} ms | 无 arguments 的调用 ${deltas.filter((entry) => !entry.hasArguments).length} 个`)
}

// tool/result error shape: SPEC assumed `error`; check what the durable log really carries.
console.log('\n=== tool/result 错误形状 ===')
const failed = []
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.type !== 'tool/result') continue
  const blocks = record.data?.message?.content
  if (Array.isArray(blocks) && blocks.some((block) => block?.isError === true)) failed.push(record)
}
console.log('带 isError 的 tool/result:', failed.length, '| 顶层 error 字段的:', [...lines].filter((line) => { try { const r = JSON.parse(line); return r.type === 'tool/result' && r.data?.error !== undefined } catch { return false } }).length)
if (failed.length > 0) {
  const block = failed[0].data.message.content.find((item) => item?.isError === true)
  console.log('isError 样例（前 200 字）:', typeof block?.content === 'string' ? block.content.slice(0, 200).replace(/\s+/g, ' ') : Array.isArray(block?.content) ? `content 是数组，块类型 ${block.content.map((item) => item?.type).join(',')}` : '(无文本)')
}
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.type === 'tool/result' && record.data?.error !== undefined) {
    console.log('顶层 error 形状:', shape(record.data.error))
    console.log('顶层 error 样例:', JSON.stringify(record.data.error).slice(0, 300))
    break
  }
}
const callIdShapes = new Set()
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.type === 'tool/call') callIdShapes.add(String(record.data?.callId).slice(0, 12).replace(/[0-9a-f]/g, 'x'))
}
console.log('tool/call 的 callId 形态样例:', [...callIdShapes].slice(0, 3).join(' | '))
