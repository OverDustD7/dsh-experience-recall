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

const PROMPT = `你在为「跨项目经验召回」做最后一道相关性检查。经验来自别的项目，要判断它能不能搬到眼前这件事上。

**用这个测试来判断（按顺序做）：**
1. 把这条经验里的**具体标识符**都遮住：项目名、目录与文件路径、接口地址、命令里的专有参数、人名、日期、进度与花费数字。
2. 问：遮住之后，**还剩不剩一条能照做的做法**（一个机制、一个坑、一个参数选择、一个判断标准）？
   - 剩得下 → 这是**可迁移的经验** → useful = true（哪怕项目、领域、语言都不同）
   - 剩不下，遮住之后就只是「某个项目做了某件事」的流水账 → 这是**私有细节** → useful = false

**例子**（照着这个尺度判）：
- 「用 pwsh 内联改写含引号的源码会被吃掉引号，多行改写要用精确替换工具」→ 遮住 pwsh 还剩做法 → true
- 「响应是 GBK 时要显式解码，中文参数也要按 GBK 编码」→ 换成任何语言都成立 → true
- 「chat-inspect 的脚本要用 ..\\venv\\Scripts\\python.exe，别用裸 python」→ 遮住路径什么都不剩 → false
- 「交接文档要写 STATUS.md 与 EVOLUTION.md，指针在文档 53ef2a52」→ 只有那个项目的约定 → false
- 「这个月花了 ¥4.39，跑了 135 步」→ 纯流水账 → false

**关于「自指」**：如果当前工作本身就是在改这个系统 / 写它的文档 / 定它的流程，那么讲这些做法的经验就是有用的；
只有当「系统本身」与当前任务无关时，才算噪音、判 false。

**两种错误的代价不同**：漏插代价高（模型只能重新摸索、重复踩坑），误插代价低（多读一条、稍微分心）。
所以在「遮住之后好像还剩点什么」与「什么都不剩」之间拿不准时，判 true。

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
