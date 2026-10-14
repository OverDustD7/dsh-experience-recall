// `/experience-recall model [name]` — the in-session switch for this plugin's
// local small model.
//
// Host-free on purpose: every effect arrives as an injected function (config read,
// live write, installed-model listing, the question card, the profile write, the
// observation log), so the command's decisions are testable with fakes and this
// module never imports a host API. `lib/index.js` supplies the real ones.
import { buildModelQuestion, rankModels } from './models.js'

export const MODEL_USAGE = [
  '经验召回 · 可用子命令',
  '/experience-recall — 运行状态（同 experience_recall_status）',
  '/experience-recall model — 列出本机 Ollama 的对话模型并选择（写回配置）',
  '/experience-recall model <名字> — 直接切到它（不弹卡）',
  '/experience-recall help — 这张说明',
].join('\n')

/** Ollama names: letters, digits, and `._:/-` (`qwen3.5:9b`, `library/qwen:latest`). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

/** Why this model name cannot be used, or null. */
function nameProblem(value) {
  const name = String(value ?? '').trim()
  if (name === '') return '没有给出模型名。用法：/experience-recall model <名字>'
  if (!MODEL_NAME.test(name)) return `模型名不合法（只能有字母数字和 . _ : / -）：${name}`
  return null
}

/**
 * Parse what the user typed after the command name.
 * @returns `{ action: 'status' | 'help' | 'pick' | 'set' | 'unknown', model?, input? }`.
 */
export function parseModelCommand(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text === '' || text === 'status' || text === '状态') return { action: 'status' }
  if (text === 'help' || text === '?' || text === '-h' || text === '--help' || text === '帮助') return { action: 'help' }
  const match = /^(?:models?|模型)(?:\s+([\s\S]*))?$/.exec(text)
  if (match === null) return { action: 'unknown', input: text }
  const rest = String(match[1] ?? '').trim()
  if (rest === '' || rest === 'list' || rest === 'ls' || rest === '列表') return { action: 'pick' }
  return { action: 'set', model: rest }
}

/**
 * Build the command. `deps` (all optional except the ones a given path uses):
 * `getConfig`, `setModel`, `listModels`, `ask`, `persist`, `statusText`, `note`.
 */
export function createModelCommand(deps = {}) {
  const {
    getConfig = () => ({}),
    setModel = () => {},
    listModels = async () => ({ ok: false, models: [], error: '没有模型列表来源' }),
    ask = async () => ({ selected: [], custom: '' }),
    persist = async () => ({ ok: false, reason: '没有配置写入通道' }),
    statusText = () => '',
    note = () => {},
    maxOptions = 20,
  } = deps

  const currentModel = () => {
    const config = getConfig() ?? {}
    return typeof config.localModel === 'string' ? config.localModel : ''
  }

  /**
   * Switch the model: live first (the judge and the card builder both read the
   * value per call), then the profile write that makes it survive a restart.
   * A failed write is reported, never swallowed — the runtime value is real and
   * the user has to know it is not persistent.
   */
  async function applyModel(next, meta = {}) {
    const from = currentModel()
    const name = String(next ?? '').trim()
    const problem = nameProblem(name)
    if (problem !== null) return { kind: 'error', text: `经验召回：${problem}` }
    const installed = Array.isArray(meta.listed) ? meta.listed.some((model) => model?.name === name) : undefined
    setModel(name)
    let saved
    try {
      saved = await persist(name)
    } catch (error) {
      saved = { ok: false, reason: String(error?.message ?? error) }
    }
    const persisted = saved?.ok === true
    note('model-changed', {
      from,
      to: name,
      via: meta.via ?? 'unknown',
      persisted,
      ...(persisted ? {} : { reason: String(saved?.reason ?? 'unknown') }),
      ...(installed === undefined ? {} : { installed }),
    })
    const lines = [`经验召回 · 小模型：${from === '' ? '（未配置）' : from} → ${name}`]
    if (persisted) lines.push('已写进本插件的配置（profile patch），重启后仍然是它。')
    else lines.push(`本次进程立即生效，但没写进配置（${saved?.reason ?? '未知原因'}）；重启后会回到 ${from === '' ? '默认值' : from}。`)
    if (installed === false) lines.push(`注意：本机 Ollama 里没看到 ${name}，判定会失败、卡片退回机械兜底。`)
    if (meta.checkError !== undefined) lines.push(`没能连上 Ollama 校验（${meta.checkError}）——名字按原样写入了；本机没有它时判定会失败、卡片退回机械兜底。`)
    if (from === name) lines.push('（本来就是它，配置已重写一遍。）')
    lines.push('判定器与建卡器都是每次调用现读这个值，所以下一条记忆就用新模型；已经建好的卡片沿用旧模型的结果。')
    return { kind: 'success', text: lines.join('\n') }
  }

  /** List what is installed and let the human pick from a card. */
  async function pick(invocation) {
    const config = getConfig() ?? {}
    const current = currentModel()
    const listed = await listModels()
    if (listed?.ok !== true) {
      return {
        kind: 'error',
        text: [
          '经验召回 · 取本机模型列表失败',
          `端点：${String(config.localEndpoint ?? '')}`,
          `原因：${String(listed?.error ?? '未知')}`,
          '可以直接写名字切（不校验是否装了）：/experience-recall model <名字>',
        ].join('\n'),
      }
    }
    const ranked = rankModels(listed.models ?? [], current, { max: maxOptions })
    if (ranked.options.length === 0) {
      return { kind: 'error', text: '经验召回：本机 Ollama 里没有可用的对话模型（只有向量模型或一个都没有）。' }
    }
    const question = buildModelQuestion({
      current,
      endpoint: config.localEndpoint ?? '',
      options: ranked.options,
      hidden: ranked.hidden,
      embeddings: ranked.embeddings,
    })
    const answer = await ask(question, invocation)
    const chosen = String(answer?.selected?.[0] ?? answer?.custom ?? '').trim()
    if (chosen === '') {
      return { kind: 'success', text: `经验召回 · 没改（仍是 ${current === '' ? '（未配置）' : current}）` }
    }
    return applyModel(chosen, { via: 'picker', invocation, listed: listed.models })
  }

  /**
   * Run one command invocation.
   * @param rawInput - text after the command name.
   * @param invocation - the host invocation (used only to route the question card).
   */
  async function run(rawInput, invocation) {
    const parsed = parseModelCommand(rawInput)
    try {
      if (parsed.action === 'help') return { kind: 'success', text: MODEL_USAGE }
      if (parsed.action === 'set') {
        const problem = nameProblem(parsed.model)
        if (problem !== null) return { kind: 'error', text: `经验召回：${problem}` }
        // One cheap local probe, so a typo is called out instead of silently
        // leaving the judge talking to a model that is not installed.
        let probe
        try {
          probe = await listModels()
        } catch (error) {
          probe = { ok: false, error: String(error?.message ?? error) }
        }
        return await applyModel(parsed.model, {
          via: 'argument',
          invocation,
          ...(probe?.ok === true ? { listed: probe.models ?? [] } : { checkError: String(probe?.error ?? '未知') }),
        })
      }
      if (parsed.action === 'pick') return await pick(invocation)
      if (parsed.action === 'unknown') {
        return { kind: 'error', text: [`经验召回：看不懂「${parsed.input}」。`, MODEL_USAGE].join('\n') }
      }
      return { kind: 'success', text: statusText() }
    } catch (error) {
      const message = String(error?.message ?? error)
      note('command-failed', { stage: parsed.action, error: message })
      return { kind: 'error', text: `经验召回：命令执行失败：${message}` }
    }
  }

  return { run, applyModel, parse: parseModelCommand }
}
