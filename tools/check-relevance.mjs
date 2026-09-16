// Relevance checker: the second stage of the trigger pipeline.
//
// Pipeline: mechanical keyword match (wide, free) -> THIS local model check
// (narrow, local GPU) -> only `useful: true` candidates may be injected.
//
// It is a separate process on purpose: a dynamic Cordis half has no `fetch`, so
// the host spawns this script through the `subprocess` service and reads stdout.
//
// Contract:
//   stdin : { context: string, card: string, model?: string, endpoint?: string, timeoutMs?: number }
//   stdout: { useful: boolean, why: string, ms: number }
//           or, when inconclusive, { error: string, ms: number, timedOut?: true }
//   exit 0 = judged, exit 3 = inconclusive (timeout / unparsable / model down)
//
// The reason on exit 3 goes to **stdout** (stderr stays empty), and `timedOut`
// marks the case where the local model never answered in time. That flag matters:
// Ollama cancels a model load the moment its client disconnects, so aborting a
// cold load and immediately asking again livelocks the load forever
// (measured 2026-09-16: 52 aborted loads in a row). The host uses the flag to
// retry once with a longer budget instead of hammering.
const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const defaultModel = argOf('--model', 'qwen3.5:9b')
const endpoint = argOf('--endpoint', 'http://localhost:11434')

const PROMPT = `你在为「跨项目经验召回」做最后一道相关性检查。
判断下面这条「历史经验」对当前工作是否真有帮助。

判断标准：
- useful = true：这条经验能直接改变当前工作怎么做（给出具体结论、参数、命令、文件路径、踩过的坑）。**经验来自别的项目也算有用**，只要它做法可以搬过来——这是本系统存在的主要理由。
- useful = false：只是话题相近、领域相同，或者当前工作完全用不上。
- 关于「自指」：先看当前工作在做什么。如果当前工作本身就是在改这个系统 / 写它的文档 / 定它的流程，那么讲这些做法的经验就是有用的；只有当「系统本身」与当前任务无关时，才算噪音、判 false。
- 宁严勿宽：拿不准就 false。

只输出一行 JSON，不要解释、不要代码块：
{"useful": true 或 false, "why": "不超过 20 字"}

当前上下文（节选）：
`

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
      if (data.length > 262144) data = data.slice(0, 262144)
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

async function main() {
  const raw = await readStdin()
  let request
  try {
    request = JSON.parse(raw)
  } catch {
    process.stdout.write(JSON.stringify({ error: 'bad request json' }))
    return 3
  }
  const context = String(request?.context ?? '').slice(0, 1200)
  const card = String(request?.card ?? '').slice(0, 900)
  if (context.trim() === '' || card.trim() === '') {
    process.stdout.write(JSON.stringify({ error: 'empty context or card' }))
    return 3
  }
  const model = typeof request?.model === 'string' && request.model !== '' ? request.model : defaultModel
  const requestEndpoint = typeof request?.endpoint === 'string' && request.endpoint !== '' ? request.endpoint : endpoint
  const timeoutMs = Number.isFinite(request?.timeoutMs) ? request.timeoutMs : 2500
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${requestEndpoint.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt: `${PROMPT}${context}\n\n历史经验卡片：\n${card}\n`,
        stream: false,
        think: false,
        options: { num_ctx: 4096, temperature: 0, num_predict: 80 },
      }),
    })
    if (!response.ok) {
      process.stdout.write(JSON.stringify({ error: `HTTP ${response.status}`, ms: Date.now() - started }))
      return 3
    }
    const payload = await response.json()
    const text = String(payload?.response ?? '')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    let parsed
    try {
      parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || typeof parsed.useful !== 'boolean') {
      process.stdout.write(JSON.stringify({ error: 'unparsable model output', raw: text.trim().slice(0, 160), ms: Date.now() - started }))
      return 3
    }
    process.stdout.write(
      JSON.stringify({
        useful: parsed.useful,
        ...(typeof parsed.readable === 'boolean' ? { readable: parsed.readable } : {}),
        why: typeof parsed.why === 'string' ? parsed.why.slice(0, 60) : '',
        ms: Date.now() - started,
        outputTokens: Number(payload?.eval_count ?? 0),
      }),
    )
    return 0
  } catch (error) {
    // `controller.signal.aborted` is the difference between "the model never
    // answered" and every other failure: only the former deserves a longer retry.
    const timedOut = controller.signal.aborted === true
    process.stdout.write(
      JSON.stringify({
        error: String(error?.message ?? error),
        ...(timedOut ? { timedOut: true } : {}),
        ms: Date.now() - started,
      }),
    )
    return 3
  } finally {
    clearTimeout(timer)
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }))
  process.exit(3)
})
