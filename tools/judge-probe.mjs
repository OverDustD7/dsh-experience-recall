// Live probe for the second-stage judge: run the shipped checker end-to-end
// against the real endpoint and report what it actually did.
//
// Why it exists: the plugin's log keeps the checker's reason only if the checker
// reports one, and the difference between "the local model never answered" and
// "the model answered no" is the difference between a broken load and a verdict —
// it decided the 2026-09-16 incident interpretation (DEV_NOTES 4.12). This is the
// smallest way to see both, on demand, without touching plugin state.
//
// Read-only: it spawns `tools/check-relevance.mjs` and prints; it writes nothing.
//
// Usage:
//   node tools/judge-probe.mjs                       # 3 warm calls, real model
//   node tools/judge-probe.mjs --n 5 --timeout-ms 5000
//   node tools/judge-probe.mjs --timeout-ms 400      # force the timeout path
//   node tools/judge-probe.mjs --context "..." --card "..."
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PLUGIN_ROOT, resolveConfig } from '../lib/config.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const config = resolveConfig({})
const times = Math.max(1, Number(argOf('--n', '3')) || 3)
const model = argOf('--model', config.localModel)
const endpoint = argOf('--endpoint', config.localEndpoint)
const timeoutMs = Number(argOf('--timeout-ms', '5500'))
const context = argOf('--context', '正在给跨项目经验召回插件排查判定器拿不到结果的问题，日志里只有 exit 3。')
const card = argOf('--card', '子进程非零退出时要把它的 stdout 一起带上，否则诊断信息全丢；本地模型冷加载期间不要用短超时反复重试，会取消加载本身。')
const checker = join(PLUGIN_ROOT, 'tools', 'check-relevance.mjs')
const nodePath = process.execPath

function once() {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(nodePath, [checker], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: -1, ms: Date.now() - started, stdout: '', stderr: String(error?.message ?? error) }))
    child.on('close', (code) => resolve({ code, ms: Date.now() - started, stdout, stderr }))
    child.stdin.end(JSON.stringify({ context, card, endpoint, model, timeoutMs }))
  })
}

console.log(`判定器探针 ${checker}`)
console.log(`模型 ${model} @ ${endpoint} | 单次预算 ${timeoutMs} ms | 调用 ${times} 次`)
let accepted = 0
let rejected = 0
let unanswered = 0
const latencies = []
for (let index = 1; index <= times; index += 1) {
  const result = await once()
  latencies.push(result.ms)
  let parsed
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    parsed = undefined
  }
  if (parsed?.useful === true) accepted += 1
  else if (parsed?.useful === false) rejected += 1
  else unanswered += 1
  const verdict = parsed?.useful === true
    ? `通过（${parsed.why ?? ''}）`
    : parsed?.useful === false
      ? `拒绝（${parsed.why ?? ''}）`
      : `未答${parsed?.timedOut === true ? '（超时）' : ''}：${parsed?.error ?? stdout.slice(0, 80).trim()}`
  console.log(`  #${index}  ${String(result.ms).padStart(5)} ms  exit ${result.code}  ${verdict}${result.stderr === '' ? '' : `   stderr=${result.stderr.trim().slice(0, 80)}`}`)
}
const sorted = latencies.slice().sort((a, b) => a - b)
console.log(`小结：通过 ${accepted} / 拒绝 ${rejected} / 未答 ${unanswered}｜延迟 中位 ${sorted[Math.floor(sorted.length / 2)]} ms 最快 ${sorted[0]} ms 最慢 ${sorted.at(-1)} ms`)
if (unanswered > 0) {
  console.log('未答不等于拒绝：它在插件里既不注入、也不计入词条信誉（0.6.2 起日志带 inconclusive 标记，报告单独统计）。')
}
