// Quality lab for the local small model (route B in SPEC 5.2.5).
//
// Question it answers: can a local model beat mechanical extraction at turning a
// memory into (a) trigger terms and (b) an injection card — and at what latency?
// It never writes anything: it reads the mnemon insight store and prints a
// side-by-side of the mechanical baseline and the model's answer.
//
// Usage:
//   node tools/card-lab.mjs [--limit 3] [--model qwen3.5:9b] [--by importance|created]
//   node tools/card-lab.mjs --review        # 抽查已建好的卡片（含所有机械兜底卡）
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PLUGIN_ROOT } from '../lib/config.js'
import { excerptOf, extractTerms, parseList } from '../lib/terms.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

// ------------------------------------------------------------- review mode ---
if (args.includes('--review')) {
  const cachePath = argOf('--cache', join(PLUGIN_ROOT, 'cache', 'cards.json'))
  const sampleEvery = Math.max(1, Number(argOf('--every', '20')))
  const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
  const entries = Object.entries(parsed?.cards ?? {})
  const bySource = new Map()
  for (const [, card] of entries) bySource.set(card?.source ?? '?', (bySource.get(card?.source ?? '?') ?? 0) + 1)
  console.log(`缓存 ${cachePath}（savedAt ${parsed?.savedAt ?? '?'}）`)
  console.log(`卡片 ${entries.length} 张，来源分布：${[...bySource.entries()].map(([key, value]) => `${key}=${value}`).join('，')}`)
  const termCounts = entries.map(([, card]) => (card?.terms ?? []).length)
  const cardLengths = entries.map(([, card]) => String(card?.card ?? '').length)
  const avg = (list) => (list.length === 0 ? 0 : Math.round(list.reduce((sum, value) => sum + value, 0) / list.length))
  console.log(`每条触发词：均 ${avg(termCounts)} 个，最少 ${Math.min(...termCounts)}，最多 ${Math.max(...termCounts)}`)
  console.log(`卡片字数：均 ${avg(cardLengths)}，最长 ${Math.max(...cardLengths)}（预算 150–200）`)
  const mechanical = entries.filter(([, card]) => card?.source === 'mechanical')
  console.log(`\n=== 机械兜底卡（模型当时失败/输出不可解析，共 ${mechanical.length} 张）===`)
  for (const [key, card] of mechanical) {
    console.log(`- ${key.slice(0, 40)}`)
    console.log(`  terms: ${(card.terms ?? []).join(' / ')}`)
    console.log(`  card : ${String(card.card ?? '').slice(0, 160)}`)
  }
  console.log(`\n=== 模型卡抽样（每 ${sampleEvery} 张取 1）===`)
  const modelCards = entries.filter(([, card]) => card?.source === 'local-model')
  for (let index = 0; index < modelCards.length; index += sampleEvery) {
    const [key, card] = modelCards[index]
    console.log(`- ${key.slice(0, 40)}`)
    console.log(`  terms: ${(card.terms ?? []).join(' / ')}`)
    console.log(`  card : ${String(card.card ?? '').slice(0, 200)}`)
  }
  const fragments = entries.filter(([key]) => key.startsWith('doc:') && key.includes('#'))
  console.log(`\n文档切片卡：${fragments.length} 张；样例：`)
  for (const [key, card] of fragments.slice(0, 5)) {
    console.log(`- ${key.slice(0, 40)} terms=${(card.terms ?? []).join(' / ')}`)
    console.log(`  card: ${String(card.card ?? '').slice(0, 160)}`)
  }
  process.exit(0)
}

const limit = Number(argOf('--limit', '3'))
const model = argOf('--model', 'qwen3.5:9b')
const orderBy = argOf('--by', 'importance')
const dbPath = argOf('--db', join(homedir(), '.dsh', 'mnemon', 'data', 'default', 'mnemon.db'))
const endpoint = argOf('--endpoint', 'http://localhost:11434')

const PROMPT = `你在为一个「跨项目经验召回」系统维护触发词表与注入卡片。给你一条作者本人写下的记忆，请输出严格 JSON：
{"terms": ["…", "…"], "card": "…"}

要求：
- terms：3–5 个**具体**的触发词。它们的用途是：当模型在别的项目里再一次遇到同一类事情时，靠这些词命中这条记忆。优先专名（域名、文件名、工具名、接口名、库名、标识符、缩写）和作者用过的独特说法；不要输出「登录」「文件」「错误」「配置」这类通用词；每个词 2–24 字；不要重复。
- card：一句话要点，不超过 120 个汉字。保留可复用的结论、关键值（域名／参数名／命令／阈值）和踩过的坑；不要复述「用户说」这类叙事，不要序号、不要标题、不要 markdown。
- 只输出 JSON 本身，不要解释、不要代码块围栏。

记忆内容：
`

function readMemories(count) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const column = orderBy === 'created' ? 'created_at' : 'effective_importance'
    const rows = db
      .prepare(`select id, content, category, tags, entities, updated_at from insights where deleted_at is null and length(content) > 120 order by ${column} desc limit ?`)
      .all(count)
    return rows.map((row) => ({
      id: row.id,
      content: String(row.content ?? ''),
      category: String(row.category ?? ''),
      tags: parseList(row.tags),
      entities: parseList(row.entities),
      updatedAt: String(row.updated_at ?? ''),
    }))
  } finally {
    db.close()
  }
}

async function askModel(memory) {
  const started = Date.now()
  const response = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `${PROMPT}${memory.content}`,
      stream: false,
      think: false,
      options: { num_ctx: 8192, temperature: 0.2, num_predict: 400 },
    }),
  })
  const ms = Date.now() - started
  if (!response.ok) return { ok: false, ms, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` }
  const payload = await response.json()
  const text = String(payload.response ?? '')
  const tokensOut = Number(payload.eval_count ?? 0)
  const evalMs = Number(payload.eval_duration ?? 0) / 1e6
  const parsed = extractJson(text)
  return {
    ok: true,
    ms,
    tokensOut,
    tokensPerSecond: evalMs > 0 ? tokensOut / (evalMs / 1000) : undefined,
    raw: text,
    terms: Array.isArray(parsed?.terms) ? parsed.terms.map((item) => String(item)) : [],
    card: typeof parsed?.card === 'string' ? parsed.card : '',
    parsed: parsed !== undefined,
  }
}

function extractJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const memories = readMemories(limit)
console.log(`模型 ${model} | 样本 ${memories.length} 条 | 来源 ${dbPath}\n`)
const results = []
for (const memory of memories) {
  const mechanicalTerms = extractTerms(memory.content, { limit: 6 })
  const mechanicalCard = excerptOf(memory.content, 220)
  console.log('='.repeat(100))
  console.log(`记忆 ${memory.id} | ${memory.category} | ${memory.content.length} 字 | 作者 tags: ${memory.tags.join(', ') || '(无)'} | entities: ${memory.entities.join(', ') || '(无)'}`)
  console.log(`原文：${memory.content.slice(0, 280)}${memory.content.length > 280 ? '…' : ''}`)
  console.log(`\n[机械] terms: ${mechanicalTerms.join(' , ') || '(无)'}`)
  console.log(`[机械] card (${mechanicalCard.length} 字): ${mechanicalCard}`)

  try {
    const answer = await askModel(memory)
    if (!answer.ok) {
      console.log(`\n[模型] 失败：${answer.error}`)
      results.push({ memory, answer })
      continue
    }
    console.log(`\n[模型] ${answer.ms} ms | 输出 ${answer.tokensOut} tok${answer.tokensPerSecond === undefined ? '' : ` | ${answer.tokensPerSecond.toFixed(1)} tok/s`} | JSON 解析: ${answer.parsed ? '成功' : '失败（原文如下）'}`)
    console.log(`[模型] terms: ${answer.terms.join(' , ') || '(无)'}`)
    console.log(`[模型] card (${answer.card.length} 字): ${answer.card}`)
    if (!answer.parsed) console.log(`[模型] 原文: ${answer.raw.slice(0, 400)}`)
    results.push({ memory, answer, mechanicalTerms, mechanicalCard })
  } catch (error) {
    console.log(`\n[模型] 异常：${error?.message ?? error}`)
    results.push({ memory, error: String(error?.message ?? error) })
  }
}

const ok = results.filter((entry) => entry.answer?.ok)
if (ok.length > 0) {
  const totalMs = ok.reduce((sum, entry) => sum + entry.answer.ms, 0)
  const cards = ok.map((entry) => entry.answer.card.length)
  const termCounts = ok.map((entry) => entry.answer.terms.length)
  console.log('\n' + '='.repeat(100))
  console.log(`汇总：成功 ${ok.length}/${results.length} | 平均 ${Math.round(totalMs / ok.length)} ms/条 | 平均 ${(totalMs / ok.length / 1000).toFixed(2)} s`)
  console.log(`卡片字数：${cards.join(', ')}（平均 ${Math.round(cards.reduce((a, b) => a + b, 0) / cards.length)}） | 机械卡片平均 ${Math.round(results.filter((r) => r.mechanicalCard).reduce((sum, r) => sum + r.mechanicalCard.length, 0) / Math.max(1, results.filter((r) => r.mechanicalCard).length))}`)
  console.log(`触发词条数：${termCounts.join(', ')}`)
  const modelTokens = ok.reduce((sum, entry) => sum + entry.answer.tokensOut, 0)
  console.log(`输出 token 合计 ${modelTokens}`)
}
