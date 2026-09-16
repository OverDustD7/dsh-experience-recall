// Mechanical keyword matching. Zero tokens, zero model calls: pure string work
// that runs inside the host process (SPEC 5.2.1).
//
// Two text views are matched, because Chinese has no word boundaries and because
// spacing around Latin terms inside Chinese text is inconsistent:
//   spaced -> whitespace collapsed to single spaces (keeps offsets meaningful)
//   tight  -> all whitespace removed (catches "清华 id" written as "清华id")
// Latin terms additionally require word boundaries so that "id" does not match
// "video" and "sso" does not match "ssoxyz".

/** Seed trigger table for stage P1. P3 replaces this with memory-derived terms. */
export const SEED_KEYWORDS = [
  // 意图型：跨项目经验（清华统一身份认证那条最有名）
  { term: '统一身份认证', kind: 'intent' },
  { term: '清华 id', kind: 'intent' },
  { term: 'id.tsinghua.edu.cn', kind: 'intent' },
  { term: 'SSO', kind: 'intent' },
  { term: '登录态', kind: 'intent' },
  { term: 'PHPSESSID', kind: 'intent' },
  { term: 'XSRF-TOKEN', kind: 'intent' },
  { term: '网络学堂', kind: 'intent' },
  { term: 'DPAPI', kind: 'intent' },
  { term: '前缀缓存', kind: 'intent' },
  { term: '浏览器卡', kind: 'intent' },
  { term: '页面卡死', kind: 'intent' },
  // 工作方式 / 流程型（实测缺口：这类抽象概念几乎不会从专名里抽出来，
  // 2026-09-14 用户问"为什么没插交接相关记忆"时暴露——词表里只有「交接文档」，
  // 没有「压缩上下文 / compaction」，所以按当时的措辞命不中）
  { term: '交接', kind: 'workflow' },
  { term: '交接文档', kind: 'workflow' },
  { term: 'handoff', kind: 'workflow' },
  { term: '压缩上下文', kind: 'workflow' },
  { term: '上下文压缩', kind: 'workflow' },
  { term: 'compaction', kind: 'workflow' },
  { term: '双写', kind: 'workflow' },
  { term: '复盘', kind: 'workflow' },
  // 动作型：它正在干什么（工具名 / 路径 / 接口）
  { term: 'cordis.patch.yml', kind: 'action' },
  { term: 'dsh.bundle.patch', kind: 'action' },
  { term: 'browser_reset_session', kind: 'action' },
  { term: 'agent/pre-step', kind: 'action' },
  { term: 'webServer.tapIndex', kind: 'action' },
  { term: 'compaction/summary', kind: 'action' },
  { term: 'mnemon recall', kind: 'action' },
  // 故障型：报错触发的召回
  { term: 'target closed', kind: 'failure' },
  { term: 'timed out', kind: 'failure' },
  { term: 'EADDRINUSE', kind: 'failure' },
  { term: 'MutationObserver', kind: 'failure' },
  { term: '主线程', kind: 'failure' },
  { term: 'EPERM', kind: 'failure' },
]

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

export function collapseWhitespace(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compile(entry) {
  const term = normalizeText(entry?.term ?? '').trim()
  if (term === '') return null
  // The tight view has no whitespace at all, so a term carrying a space must be
  // matched there in its whitespace-free form ("清华 id" -> "清华id").
  const tightTerm = term.replace(/\s+/g, '')
  const latin = !CJK.test(term)
  return {
    term,
    tightTerm,
    kind: typeof entry?.kind === 'string' ? entry.kind : 'unknown',
    source: typeof entry?.source === 'string' ? entry.source : 'seed',
    memoryId: typeof entry?.memoryId === 'string' ? entry.memoryId : undefined,
    // A derived term carries the card of the memory that owns it, so a direct
    // keyword hit can be injected without any retrieval round trip.
    excerpt: typeof entry?.excerpt === 'string' && entry.excerpt !== '' ? entry.excerpt : undefined,
    latin,
    regex: latin ? new RegExp(`(?<![a-z0-9_])${escapeRegExp(term)}(?![a-z0-9_])`, 'g') : null,
    tightRegex: latin && tightTerm !== term ? new RegExp(`(?<![a-z0-9_])${escapeRegExp(tightTerm)}(?![a-z0-9_])`, 'g') : null,
  }
}

/** Compile a trigger table once; matchKeywords() then works on plain strings. */
export function buildTable(entries = []) {
  const compiled = []
  const seen = new Set()
  for (const entry of entries) {
    const item = compile(entry)
    if (item === null || seen.has(item.term)) continue
    seen.add(item.term)
    compiled.push(item)
  }
  return { items: compiled }
}

export function mergeTables(base, extra) {
  return buildTable([...(base?.items ?? []), ...(extra ?? [])])
}

function contextAround(view, index, length, contextChars) {
  const start = Math.max(0, index - contextChars)
  const end = Math.min(view.length, index + length + contextChars)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < view.length ? '…' : ''
  return `${prefix}${view.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/**
 * Match one text against a compiled table.
 * @returns array of `{ term, kind, source, memoryId, view, context }`
 */
export function matchKeywords(text, table, options = {}) {
  const contextChars = Number.isFinite(options.contextChars) ? Math.max(0, Math.floor(options.contextChars)) : 60
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 32
  const normalized = normalizeText(text)
  const spaced = normalized.replace(/\s+/g, ' ').trim()
  const tight = normalized.replace(/\s+/g, '')
  if (spaced === '' && tight === '') return []
  const hits = []
  for (const item of table?.items ?? []) {
    // Both needle forms are always tried: the spaced form keeps offsets usable
    // for the context window, the tight form catches text written without spaces.
    const candidates = [{ name: 'spaced', text: spaced, needle: item.term, regex: item.regex }]
    if (item.tightTerm !== item.term) candidates.push({ name: 'tight', text: tight, needle: item.tightTerm, regex: item.tightRegex ?? item.regex })
    for (const candidate of candidates) {
      if (candidate.needle === '') continue
      let index = -1
      if (candidate.regex !== null) {
        candidate.regex.lastIndex = 0
        const match = candidate.regex.exec(candidate.text)
        index = match === null ? -1 : match.index
      } else {
        index = candidate.text.indexOf(candidate.needle)
      }
      if (index < 0) continue
      hits.push({
        term: item.term,
        kind: item.kind,
        ...(item.source === undefined ? {} : { source: item.source }),
        ...(item.memoryId === undefined ? {} : { memoryId: item.memoryId }),
        ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
        view: candidate.name,
        context: contextAround(candidate.text, index, candidate.needle.length, contextChars),
      })
      break
    }
    if (hits.length >= limit) break
  }
  return hits
}

export { CJK }
