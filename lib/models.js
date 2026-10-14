// Local model inventory for the in-session model picker.
//
// The plugin's small model is a config value, and the only honest list of what it
// may be is what Ollama actually has installed (`GET /api/tags`). Everything here
// is a pure function of that payload except `listLocalModels`, which performs the
// single fetch — so ranking, filtering and the question card stay unit-testable
// without a host, a running Ollama, or a GPU.

/** Models that can only embed: a judge/card builder can never use them. */
const EMBEDDING_NAME = /(^|[:_\-/])(bge|embed|embedding|minilm|gte|e5|nomic)([:_\-/]|$)/i

/** `GET /api/tags` for one configured endpoint (trailing slashes forgiven). */
export function tagsUrl(endpoint) {
  const base = String(endpoint ?? '').trim().replace(/\/+$/, '')
  return `${base}/api/tags`
}

/**
 * Whether one installed model is embedding-only.
 * @param name - the Ollama model name (`bge-m3:latest`).
 * @param details - the payload's `details` object, when present.
 * @returns true when the model cannot serve a chat/judge request.
 */
export function isEmbeddingModel(name, details = {}) {
  const family = typeof details?.family === 'string' ? details.family : ''
  if (/bert|embed/i.test(family)) return true
  // Ollama reports embedding models with `family: "bert"` in current versions, but
  // the name test is what survives a version that reports a different family.
  return EMBEDDING_NAME.test(String(name ?? ''))
}

/**
 * Normalize a `/api/tags` payload into the fields the picker needs. Unreadable
 * entries are dropped rather than guessed at: a wrong name in the option list
 * would switch the plugin to a model that does not exist.
 * @param payload - parsed JSON body of `GET /api/tags`.
 * @returns one record per installed model.
 */
export function parseTags(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : []
  const out = []
  for (const item of models) {
    const name = typeof item?.name === 'string' && item.name !== ''
      ? item.name
      : (typeof item?.model === 'string' ? item.model : '')
    if (name === '') continue
    const details = item?.details ?? {}
    out.push({
      name,
      sizeBytes: Number.isFinite(item?.size) ? item.size : 0,
      parameters: typeof details.parameter_size === 'string' ? details.parameter_size : '',
      quantization: typeof details.quantization_level === 'string' ? details.quantization_level : '',
      family: typeof details.family === 'string' ? details.family : '',
      embedding: isEmbeddingModel(name, details),
    })
  }
  return out
}

/** Human byte size for a card description (`6.15 GB`). */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled >= 100 || unit === 0 ? Math.round(scaled) : scaled.toFixed(2)} ${units[unit]}`
}

/** One line of option context: size, parameter count, quantization. */
export function describeModel(model) {
  const parts = []
  if (model?.sizeBytes > 0) parts.push(formatBytes(model.sizeBytes))
  if (typeof model?.parameters === 'string' && model.parameters !== '') parts.push(model.parameters)
  if (typeof model?.quantization === 'string' && model.quantization !== '') parts.push(model.quantization)
  return parts.join(' · ')
}

/**
 * The option order the picker shows: the current model first (so "keep it" is one
 * click), then every other chat model smallest-first — this model runs on every
 * judged step, so latency outranks benchmark scores.
 * @returns options (capped), how many were left out, and how many were embeddings.
 */
export function rankModels(models, current, options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 20
  const list = Array.isArray(models) ? models : []
  const chat = list.filter((model) => model?.embedding !== true && typeof model?.name === 'string' && model.name !== '')
  const currentName = String(current ?? '')
  const first = chat.filter((model) => model.name === currentName)
  const rest = chat
    .filter((model) => model.name !== currentName)
    .sort((a, b) => (a.sizeBytes || Infinity) - (b.sizeBytes || Infinity) || a.name.localeCompare(b.name))
  const ordered = [...first, ...rest]
  return {
    options: ordered.slice(0, max),
    hidden: Math.max(0, ordered.length - max),
    embeddings: list.length - chat.length,
  }
}

/**
 * The single question the picker asks. Answered by option label; closing the card
 * without picking means "no change", which the command reports as such.
 */
export function buildModelQuestion(input = {}) {
  const current = String(input.current ?? '')
  const options = Array.isArray(input.options) ? input.options : []
  const lines = []
  if (current === '') lines.push('当前没有配置小模型（判定会退回机械兜底）。')
  else lines.push(`当前：${current}`)
  if (input.hidden > 0) lines.push(`另有 ${input.hidden} 个未列出（列表最多 ${options.length + input.hidden} 个，按体积从小到大取前 ${options.length} 个）。`)
  if (input.embeddings > 0) lines.push(`已跳过 ${input.embeddings} 个向量模型（不能做判定/建卡）。`)
  lines.push('换到哪个？（这张卡关掉＝不改）')
  return {
    id: 'experience-recall-model',
    header: '经验召回 · 本机小模型',
    question: lines.join('\n'),
    detail: `端点：${String(input.endpoint ?? '')}。选完立即生效，并写进 profile 配置（重启仍是它）。`,
    multiSelect: false,
    options: options.map((model) => ({
      label: model.name,
      description: [model.name === current ? '当前' : '', describeModel(model)].filter(Boolean).join(' · '),
    })),
  }
}

/**
 * Fetch the installed-model list. Never throws: a stopped Ollama is a normal
 * condition the command must report, not an exception that kills a turn.
 * @returns `{ ok, models, error, ms }`.
 */
export async function listLocalModels(options = {}) {
  const endpoint = String(options.endpoint ?? '').trim()
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : 5000
  const started = Date.now()
  if (endpoint === '') return { ok: false, models: [], error: '没有配置 Ollama 端点', ms: 0 }
  if (typeof fetchImpl !== 'function') return { ok: false, models: [], error: '这个 Node 运行时没有 fetch', ms: 0 }
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetchImpl(tagsUrl(endpoint), {
      method: 'GET',
      ...(controller === undefined ? {} : { signal: controller.signal }),
    })
    if (response?.ok !== true) {
      return { ok: false, models: [], error: `HTTP ${response?.status ?? '?'}`, ms: Date.now() - started }
    }
    const payload = await response.json()
    return { ok: true, models: parseTags(payload), error: null, ms: Date.now() - started }
  } catch (error) {
    const message = String(error?.name === 'AbortError' ? `超过 ${timeoutMs} ms 没有响应` : (error?.message ?? error))
    return { ok: false, models: [], error: message, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}
