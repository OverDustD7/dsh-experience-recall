// Turning one memory into (a) trigger terms and (b) an injection card.
//
// Two builders: mechanical (always available, zero latency) and the local small
// model behind Ollama (SPEC 5.2.5 route B). The model is optional: if it is
// unconfigured, unreachable, slow, or returns junk, the mechanical result is
// used instead, so the pipeline never depends on it being up.
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { excerptOf, extractTerms, isUsableTerm, normalizeTerm } from './terms.js'

export const CARD_PROMPT = `你在为一个「跨项目经验召回」系统维护触发词表与注入卡片。给你一条作者本人写下的记忆，请输出严格 JSON：
{"terms": ["…", "…"], "card": "…"}

要求：
- terms：3–5 个**具体**的触发词。它们的用途是：当模型在别的项目里再一次遇到同一类事情时，靠这些词命中这条记忆。优先专名（域名、文件名、工具名、接口名、库名、标识符、缩写）和作者用过的独特说法；不要输出「登录」「文件」「错误」「配置」这类通用词；每个词 2–24 字；不要重复。
- card：一句话要点，不超过 120 个汉字。保留可复用的结论、关键值（域名／参数名／命令／阈值）和踩过的坑；不要复述「用户说」这类叙事，不要序号、不要标题、不要 markdown。
- 只输出 JSON 本身，不要解释、不要代码块围栏。

记忆内容：
`

/**
 * Revisions kept per stable id. Measured: the first version evicted the oldest
 * inserted key once the cache exceeded a flat limit, which threw away memory
 * cards (the most valuable half) while the growing fragment half pushed the
 * cache past the limit. Revisions of one card are cheap; losing whole cards is not.
 */
const REVISIONS_PER_ID = 2
/** Bound one document's fragment count so a huge file cannot flood the table. */
const MAX_FRAGMENTS_PER_DOCUMENT = 40

function dedupeTerms(list, limit) {
  const out = []
  const seen = new Set()
  for (const item of list ?? []) {
    const term = normalizeTerm(item)
    if (term === '' || seen.has(term) || !isUsableTerm(term)) continue
    seen.add(term)
    out.push(term)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Drop a term that is only a fragment of a longer kept term:
 * `message.data.message.content` adds nothing next to
 * `assistant/message.data.message.content` (measured noise in the lab).
 */
function dropFragments(list) {
  return list.filter((term) => !list.some((other) => other !== term && other.includes(term) && other.length > term.length))
}

/** Author tags/entities first, then structural proper nouns from the text. */
export function mechanicalTerms(record, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 5
  const fromText = dedupeTerms(extractTerms(record?.content ?? '', { limit: limit * 3 }), limit * 2)
  const fromAuthor = dedupeTerms([...(record?.tags ?? []), ...(record?.entities ?? [])], limit * 2)
  // Author terms win, but the fragment pass runs on the merged list so a bare
  // `zhjwxk` never ships next to `zhjwxk.cic.tsinghua.edu.cn`.
  const merged = dropFragments([...new Set([...fromAuthor, ...fromText])])
  return merged.slice(0, limit)
}

export function mechanicalCard(record, options = {}) {
  return excerptOf(record?.content ?? '', Number.isFinite(options.chars) ? options.chars : 220)
}

function extractJson(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * Ask the local model for terms + a card.
 * @returns `{ ok, terms, card, ms, error? }` — never throws.
 */
export async function askLocalModel(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const endpoint = typeof options.endpoint === 'string' ? options.endpoint : 'http://localhost:11434'
  const model = typeof options.model === 'string' ? options.model : ''
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000
  if (model === '' || typeof fetchImpl !== 'function') return { ok: false, terms: [], card: '', ms: 0, error: 'local model not configured' }
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetchImpl(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller?.signal,
      body: JSON.stringify({
        model,
        prompt: `${CARD_PROMPT}${options.content ?? ''}`,
        stream: false,
        think: false,
        options: {
          num_ctx: Number.isFinite(options.numCtx) ? options.numCtx : 8192,
          temperature: 0.2,
          num_predict: Number.isFinite(options.numPredict) ? options.numPredict : 400,
        },
      }),
    })
    const ms = Date.now() - started
    if (!response.ok) return { ok: false, terms: [], card: '', ms, error: `HTTP ${response.status}` }
    const payload = await response.json()
    const parsed = extractJson(payload?.response)
    if (parsed === undefined) return { ok: false, terms: [], card: '', ms, error: 'unparsable model output' }
    const terms = dropFragments(dedupeTerms(Array.isArray(parsed.terms) ? parsed.terms : [], 5))
    // The model measurably overshoots an instruction-only length limit (276–281
    // chars against a 120-character request), so the budget is enforced here.
    const card = excerptOf(typeof parsed.card === 'string' ? parsed.card : '', Number.isFinite(options.cardChars) ? options.cardChars : 150)
    if (card === '') return { ok: false, terms, card: '', ms, error: 'empty card' }
    return { ok: true, terms, card, ms, ...(typeof parsed.card === 'string' && parsed.card.length > card.length ? { trimmed: parsed.card.length } : {}) }
  } catch (error) {
    return { ok: false, terms: [], card: '', ms: Date.now() - started, error: String(error?.message ?? error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Card builder used by the memory watcher. `mode: 'local'` tries the local model
 * and silently degrades; anything else is purely mechanical.
 */
export function createCardBuilder(options = {}) {
  const config = options.config ?? {}
  const logger = options.logger
  const mode = config.cardBuilder === 'local' ? 'local' : 'mechanical'
  const cache = new Map()
  const cachePath = typeof options.cachePath === 'string' && options.cachePath !== '' ? options.cachePath : ''
  const stats = { built: 0, mechanical: 0, model: 0, modelFailed: 0, cacheHits: 0, modelMs: 0, persisted: 0, documents: 0, fragments: 0, pruned: 0, compacted: 0, retained: 0, documentsInert: 0, revalidated: 0, revalidatedCards: 0 }
  let loaded = false
  let dirty = false
  let loadFailed = false

  function log(record) {
    try {
      logger?.write(record)
    } catch {
      // best effort by contract
    }
  }

  /**
   * A model-built card costs seconds, so results are persisted keyed by
   * `memoryId:revision`. A restart then rebuilds only what actually changed —
   * measured: 238 memories would otherwise mean ~8 minutes of local GPU work on
   * every host start.
   */
  async function load() {
    if (loaded || cachePath === '') return
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(cachePath, 'utf8'))
      if (parsed?.cards === null || typeof parsed?.cards !== 'object' || Array.isArray(parsed.cards)) throw new Error('invalid card cache')
      for (const [key, value] of Object.entries(parsed.cards)) {
        if (value === null || typeof value !== 'object' || typeof value.card !== 'string' || !Array.isArray(value.terms)) throw new Error('invalid card entry')
        cache.set(key, value)
      }
      stats.persisted = cache.size
    } catch (error) {
      // Distinguish "no cache yet" from "cache unreadable": a transient read
      // failure must never license overwriting a good cache with a partial one.
      loadFailed = String(error?.code ?? '') !== 'ENOENT'
    }
  }

  async function save() {
    if (cachePath === '' || !dirty) return
    if (loadFailed) {
      log({ kind: 'card', phase: 'save', outcome: 'skipped', reason: 'cache was unreadable; refusing to overwrite it' })
      return
    }
    // Guard against self-destruction: a process that loaded a full cache but was
    // then driven by a small fixture would otherwise persist that fixture over the
    // real index. Two independent refusals:
    //   (a) the store still declares far more cards than are about to be written —
    //       that is the shape of the bug that emptied this cache once (declared
    //       1095, wrote 11);
    //   (b) a catastrophic shrink that compaction cannot explain.
    const declared = Number.isFinite(stats.lastDeclared) ? stats.lastDeclared : cache.size
    if (declared > 0 && cache.size < declared * 0.5) {
      log({ kind: 'card', phase: 'save', outcome: 'refused', reason: 'fewer entries than the store declares', declared, current: cache.size })
      return
    }
    if (stats.persisted >= 100 && cache.size < stats.persisted / 4 && declared <= cache.size) {
      log({ kind: 'card', phase: 'save', outcome: 'refused', reason: 'catastrophic shrink', persisted: stats.persisted, current: cache.size, declared })
      return
    }
    const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
    dirty = false
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      const persistedCount = cache.size
      const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), cards: Object.fromEntries(cache) })
      // Publish atomically so a crash cannot leave a half-written index behind.
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, cachePath)
      stats.persisted = persistedCount
    } catch (error) {
      dirty = true
      log({ kind: 'card', phase: 'save', outcome: 'failed', error: String(error?.message ?? error) })
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async function build(record, revision = '') {
    const key = `${record?.id ?? '?'}:${revision}`
    const hit = cache.get(key)
    if (hit !== undefined) {
      stats.cacheHits += 1
      return { ...hit, key }
    }
    const cardChars = Number.isFinite(config.cardChars) ? config.cardChars : 150
    let result = { terms: mechanicalTerms(record), card: mechanicalCard(record, { chars: cardChars }), source: 'mechanical' }
    stats.mechanical += 1
    if (mode === 'local' && config.localModel !== '') {
      const answer = await askLocalModel({
        endpoint: config.localEndpoint,
        model: config.localModel,
        content: record?.content ?? '',
        timeoutMs: config.localTimeoutMs,
        numCtx: config.localNumCtx,
        cardChars,
        fetchImpl: options.fetchImpl,
      })
      if (answer.ok) {
        const terms = answer.terms.length > 0 ? answer.terms : result.terms
        result = { terms, card: answer.card, source: 'local-model', ...(answer.trimmed === undefined ? {} : { trimmedFrom: answer.trimmed }) }
        stats.model += 1
        stats.modelMs += answer.ms
      } else {
        stats.modelFailed += 1
        log({ kind: 'card', source: 'local-model', outcome: 'fallback', id: record?.id, error: answer.error })
      }
    }
    const stored = {
      id: String(record?.id ?? '?'),
      terms: result.terms,
      card: result.card,
      source: result.source,
      ...(result.trimmedFrom === undefined ? {} : { trimmedFrom: result.trimmedFrom }),
      key,
    }
    cache.set(key, stored)
    dirty = true
    stats.built += 1
    return stored
  }

  /**
   * Tier 2 card for one project document. Persisted under `doc:<id>:<revision>`
   * so the runtime vocabulary (which reads only the cache) actually contains the
   * document half — measured: without this, all ~100 documents were silently
   * absent from the trigger table.
   */
  function buildDocument(document, revision = '') {
    const key = `doc:${document?.id ?? '?'}:${revision}`
    const hit = cache.get(key)
    // Same guard as fragments: never keep serving a card that cannot fire.
    if (hit !== undefined && Array.isArray(hit.terms) && hit.terms.length > 0) {
      stats.cacheHits += 1
      return { ...hit, key }
    }
    const terms = dropFragments(dedupeTerms([...extractTerms(document?.title ?? '', { limit: 4 }), ...extractTerms(document?.description ?? '', { limit: 4 })], 4))
    const card = excerptOf([document?.title, document?.description].filter((part) => typeof part === 'string' && part !== '').join('：'), 150)
    // A card with no usable term is inert: it can never be matched, so storing it
    // only inflates the corpus (and therefore the ubiquity denominator) while
    // contributing nothing. Measured: 18 of 107 document cards were in that state.
    const result = { terms, card, source: 'document' }
    if (terms.length === 0) {
      stats.documentsInert = (stats.documentsInert ?? 0) + 1
      log({ kind: 'card', phase: 'document-skipped', id: document?.id, reason: 'no usable term' })
      cache.delete(key)
      dirty = true
      return result
    }
    const stored = { id: `doc:${document?.id ?? '?'}`, ...result, key }
    cache.set(key, stored)
    dirty = true
    stats.documents += 1
    return stored
  }

  /**
   * Tier 2 fragments (SPEC 5.2.4): a document is not one 8 KB card, it is its
   * `##` sections, each ~1 KB and each with its own heading and proper nouns.
   * Measured motivation: a document-level card is either too coarse (title only)
   * or too big to inject; a 1 KB section is the right granularity to match on.
   */
  function buildDocumentFragments(document, text, revision = '') {
    const id = String(document?.id ?? '?')
    const title = String(document?.title ?? '')
    const sections = splitSections(String(text ?? '')).slice(0, MAX_FRAGMENTS_PER_DOCUMENT)
    const out = []
    for (const section of sections) {
      const key = `doc:${id}#${section.index}:${revision}`
      const memoryId = `doc:${id}#${section.index}`
      const hit = cache.get(key)
      // Measured: an older build cached fragments with an empty term list, and a
      // cache hit would keep serving them forever (36 of them were in the live
      // vocabulary, unfireable by construction). Recompute instead of trusting it.
      if (hit !== undefined && Array.isArray(hit.terms) && hit.terms.length > 0) {
        stats.cacheHits += 1
        out.push({ memoryId, ...hit })
        continue
      }
      const heading = section.heading
      const body = section.body
      const terms = dropFragments(
        dedupeTerms(
          [
            ...(heading !== '' && heading.length <= 24 ? [heading] : []),
            ...extractTerms(`${title} ${heading} ${body.slice(0, 400)}`, { limit: 4 }),
          ],
          4,
        ),
      )
      const label = heading === '' ? title : `${title} § ${heading}`
      const card = excerptOf([label, firstSentence(body)].filter((part) => part !== '').join('：'), Number.isFinite(config.fragmentChars) ? config.fragmentChars : 200)
      if (card === '' || terms.length === 0) continue
      const built = { id: memoryId, terms, card, source: 'document-fragment', key }
      cache.set(key, built)
      dirty = true
      stats.fragments += 1
      out.push({ memoryId, ...built })
    }
    return out
  }

  /** Split markdown into `##` sections; the pre-heading intro belongs to index 0. */
  function splitSections(text) {
    const lines = text.split(/\r?\n/)
    const sections = []
    let current = { index: 0, heading: '', body: [] }
    let started = false
    for (const line of lines) {
      const match = /^##\s+(.+?)\s*$/.exec(line)
      if (match !== null) {
        if (started || current.body.join('').trim() !== '') sections.push(current)
        current = { index: sections.length, heading: match[1], body: [] }
        started = true
        continue
      }
      if (/^#\s+/.test(line)) continue
      current.body.push(line)
    }
    if (started || current.body.join('').trim() !== '') sections.push({ ...current, index: sections.length })
    return sections
      .map((section) => ({ index: section.index, heading: section.heading.trim(), body: section.body.join('\n').replace(/\s+/g, ' ').trim() }))
      .filter((section) => section.body.length > 60)
  }

  function firstSentence(body) {
    const text = String(body ?? '').trim()
    if (text === '') return ''
    const cut = text.search(/[。．.!?！？]/)
    return cut >= 10 ? text.slice(0, cut + 1) : text.slice(0, 160)
  }

  /**
   * Strip terms rejected by a corpus-wide filter (document frequency) from the
   * persisted cache, so the dynamic runtime — which reads only the cache — sees
   * the same vocabulary as the resident plugin.
   */
  function prune(predicate) {
    let removed = 0
    for (const [key, value] of cache) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.terms)) continue
      const kept = value.terms.filter((term) => predicate(term) !== true)
      if (kept.length === value.terms.length) continue
      removed += value.terms.length - kept.length
      cache.set(key, { ...value, terms: kept })
      dirty = true
    }
    if (removed > 0) {
      stats.pruned = (stats.pruned ?? 0) + removed
      log({ kind: 'card', phase: 'prune', removed })
    }
    return removed
  }

  /**
   * Stable identity of a card. It is stored IN the card (`id`), never derived by
   * splitting the cache key: a revision is `<updatedAt>|<length>` and an ISO
   * timestamp is full of colons, so `key.slice(0, lastIndexOf(':'))` silently
   * produced `doc:<uuid>:2026-09-14T09:21` — measured cost: `compact()` treated
   * 1084 of 1095 live cards as orphans and deleted the whole cache.
   * Returns `null` for a legacy entry that predates the field; callers must then
   * stay conservative (never call it an orphan).
   */
  function stableIdOf(value) {
    const id = value?.id
    return typeof id === 'string' && id !== '' ? id : null
  }

  /** The revision part of `<id>:<revision>`, given the id it was built with. */
  function revisionOf(key, id) {
    const prefix = `${id}:`
    const text = String(key)
    return text.startsWith(prefix) ? text.slice(prefix.length) : null
  }

  /**
   * Drop entries no longer reachable from the current store: revisions nobody
   * refers to any more, and cards that carry no term at all (they can never be
   * matched, so keeping them only inflates the corpus and the ubiquity budget).
   * Returns the number of entries removed.
   */
  function compact(declaredLive) {
    const live = new Map()
    for (const [memoryId, revision] of declaredLive ?? []) {
      if (typeof memoryId !== 'string' || memoryId === '' || revision === undefined) continue
      live.set(memoryId, String(revision))
    }
    const authoritative = declaredLive instanceof Map
    let removed = 0
    for (const [key, value] of cache) {
      const terms = Array.isArray(value?.terms) ? value.terms : undefined
      // A card with no term can never fire; that check needs no identity at all.
      if (terms === undefined || terms.length === 0) {
        cache.delete(key)
        removed += 1
        continue
      }
      const id = stableIdOf(value)
      if (id === null || !authoritative) continue
      // With a declared live set, an entry whose id is absent from the store is an
      // orphan, and one at the wrong revision is stale. Both must go — the first
      // version only handled the wrong revision, so a card whose memory was
      // forgotten stayed in the vocabulary (and in the ubiquity denominator).
      const declared = live.get(id)
      const revision = revisionOf(key, id)
      const orphan = declared === undefined
      const stale = declared !== undefined && revision !== null && declared !== revision
      if (orphan || stale) {
        cache.delete(key)
        removed += 1
      }
    }
    stats.lastDeclared = live.size
    if (removed > 0) {
      stats.compacted = (stats.compacted ?? 0) + removed
      dirty = true
      log({ kind: 'card', phase: 'compact', removed, declared: live.size })
    }
    return removed
  }

  /**
   * Bound historical revisions per card. Live revisions are never touched, so a
   * big fragment table can never evict a memory card the way the old flat cache
   * limit did.
   */
  function enforceRevisionBudget() {
    const groups = new Map()
    for (const [key, value] of cache) {
      // Group by the id stored in the card, never by splitting the key (a revision
      // contains colons; see stableIdOf).
      const id = stableIdOf(value)
      if (id === null) continue
      const list = groups.get(id) ?? []
      list.push(String(key))
      groups.set(id, list)
    }
    let removed = 0
    for (const keys of groups.values()) {
      if (keys.length <= REVISIONS_PER_ID) continue
      keys.sort()
      for (const key of keys.slice(0, keys.length - REVISIONS_PER_ID)) {
        cache.delete(key)
        removed += 1
      }
    }
    if (removed > 0) {
      stats.prunedRevisions = (stats.prunedRevisions ?? 0) + removed
      dirty = true
      log({ kind: 'card', phase: 'revision-budget', removed, perId: REVISIONS_PER_ID })
    }
    return removed
  }

  /**
   * Drop cached entries whose stable id is no longer in the store at all — a
   * cheaper, revision-agnostic sweep for archives and forgotten memories.
   */
  function retain(predicate) {
    let removed = 0
    for (const key of [...cache.keys()]) {
      if (predicate(key) === false) {
        cache.delete(key)
        removed += 1
      }
    }
    if (removed > 0) {
      stats.retained = (stats.retained ?? 0) + removed
      dirty = true
      log({ kind: 'card', phase: 'retain', removed })
    }
    return removed
  }

  /**
   * Drop cached terms that the CURRENT rules would not accept any more, and drop
   * any card left without a term. The cache is keyed by `id:revision`, so a
   * revision that has not changed keeps the terms it was built with — measured:
   * after tightening the term shape rules, `content_hash:` and a slash dump were
   * still live in the vocabulary until their cards happened to change.
   */
  function revalidate() {
    let droppedTerms = 0
    let droppedCards = 0
    for (const [key, value] of cache) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.terms)) continue
      const kept = value.terms.filter((term) => isUsableTerm(term))
      if (kept.length === value.terms.length) continue
      droppedTerms += value.terms.length - kept.length
      if (kept.length === 0) {
        cache.delete(key)
        droppedCards += 1
        continue
      }
      cache.set(key, { ...value, terms: kept })
    }
    if (droppedTerms > 0 || droppedCards > 0) {
      stats.revalidated = (stats.revalidated ?? 0) + droppedTerms
      stats.revalidatedCards = (stats.revalidatedCards ?? 0) + droppedCards
      dirty = true
      log({ kind: 'card', phase: 'revalidate', droppedTerms, droppedCards })
    }
    return { droppedTerms, droppedCards }
  }

  /** Every distinct term currently in the in-memory cache (the live corpus). */
  function cachedTerms() {    const terms = []
    for (const value of cache.values()) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.terms)) continue
      for (const term of new Set(value.terms.map((item) => String(item)))) terms.push(term)
    }
    return terms
  }

  /** Whether this exact card revision is already persisted in the cache. */
  function has(key) {
    return cache.has(String(key))
  }

  return { build, buildDocument, buildDocumentFragments, load, save, prune, compact, enforceRevisionBudget, revalidate, retain, stableIdOf, revisionOf, cachedTerms, has, stats: () => ({ ...stats, cache: cache.size, mode }), mode }
}
