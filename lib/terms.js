// Mechanical term extraction for the trigger vocabulary.
//
// The vocabulary must not be a hand-written snapshot: new memories arrive all
// the time (usually through `mnemon_remember` + a project document). Terms are
// therefore derived from real memory — author-provided tags/entities plus the
// structural proper nouns inside the text (hosts, file names, identifiers,
// ALL-CAPS acronyms, quoted titles).
//
// Deliberately conservative: a bad term costs a wasted recall and a noisy card,
// so free Chinese prose is NOT mined into n-grams (tags/entities cover that).

/** Words too generic to trigger on (SPEC 5.1.1 gate one). */
export const GENERIC_TERMS = new Set([
  'id', 'ids', 'error', 'errors', 'bug', 'file', 'files', 'path', 'paths', 'data', 'test', 'tests',
  'true', 'false', 'null', 'undefined', 'string', 'number', 'object', 'array', 'value', 'name',
  'type', 'item', 'list', 'map', 'set', 'get', 'run', 'code', 'user', 'users', 'time', 'date',
  '登录', '文件', '目录', '数据', '时间', '问题', '方法', '配置', '项目', '系统', '说明', '注意',
  '错误', '信息', '内容', '结果', '功能', '工具', '插件', '记录', '任务', '文档', '版本', '参数',
])

const KNOWN_EXTENSIONS = new Set([
  'yml', 'yaml', 'json', 'jsonl', 'md', 'txt', 'js', 'mjs', 'cjs', 'ts', 'py', 'ps1', 'sh',
  'exe', 'db', 'sqlite', 'log', 'ini', 'toml', 'csv', 'xlsx', 'docx', 'pptx', 'html', 'css',
])

/** Country/legacy suffixes whose one-dot forms are almost always noise. */
const TLDS = new Set(['cn', 'com', 'org', 'net', 'io', 'edu', 'gov', 'co', 'uk', 'dev'])

const PATTERNS = [
  // hosts, file names, dotted identifiers: id.tsinghua.edu.cn, cordis.patch.yml
  /\b[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+){1,4}\b/gi,
  // paths: lib/index.js, D:\Project\DSH
  /[a-z0-9_.-]+[\\/][a-z0-9_.\\/-]+/gi,
  // ALL-CAPS acronyms: SSO, DPAPI, PHPSESSID, EADDRINUSE
  /\b[A-Z][A-Z0-9_]{2,}\b/g,
  // snake_case identifiers: browser_reset_session, agent_pre_step
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,3}\b/gi,
  // quoted titles: 《…》「…」
  /[「『《"“]([^」』》"”\n]{2,24})[」』》"”]/g,
]

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * Upper bound on a trigger term. Latin technical tokens legitimately run long
 * (`zhjwxk.cic.tsinghua.edu.cn` is 26 characters and is exactly the kind of term
 * this vocabulary exists for), so the hard ceiling is generous and the real
 * guard is the CJK-heavy limit below.
 */
export const MAX_TERM_LENGTH = 48

/**
 * A Chinese phrase is not a term. Measured: the mechanical/model paths produced
 * 25–48 character CJK strings — document titles and quoted instructions verbatim
 * (`渲染你可以留...你的对齐比较好看,...`) — which can only match when the whole
 * sentence reappears. Proper nouns the extractor is meant to find are short.
 */
export const MAX_CJK_TERM_LENGTH = 24

/**
 * A sentence, not a term. Measured: the model returns quoted instructions verbatim
 * (`渲染你可以留...你的对齐比较好看,...`), and the mechanical patterns pick up
 * shell/CSS fragments (`; $env:mnemon_store=`, `right:0;width:var(--cfw-right)`,
 * `display:inline-flex !important`) plus quoted questions (`这跟我有什么关系?`).
 * Such strings can only match when the whole thing reappears: pure bloat.
 * Measured share of the live vocabulary: 11 of 2506 terms.
 *
 * Deliberately NOT filtered: 157 CJK-heavy phrases longer than 15 characters
 * (`maic 全ai守护的自适应课堂`, section headings reused as fragment terms). They are
 * nearly impossible to match, so they cost nothing, and when one does match it is a
 * high-precision exact hit — dropping them would be a net loss.
 */
const PROSE_PUNCTUATION = /[。；！？!?;,，、…]|(?:\.\.\.)/
/** Trailing separators come from dumping a schema or a path, never from a name. */
const TRAILING_SEPARATOR = /[:/\\|]+$/
/** Three or more separators is a list, not a name. */
const SEPARATOR_DUMP = /(?:[:/\\|][^:/\\|\s]{0,24}){3,}[:/\\|]/

export function normalizeTerm(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Author-provided tags/entities arrive as a JSON array text (or a list). */
export function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.trim() !== '')
  if (typeof value !== 'string' || value.trim() === '') return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter((item) => item.trim() !== '')
  } catch {
    return value
      .split(/[,，、;；]/)
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }
  return []
}

/** Whether a candidate is specific enough to spend a recall on. */
export function isUsableTerm(value) {
  const term = normalizeTerm(value)
  if (term === '' || term.length > MAX_TERM_LENGTH) return false
  if (term.length < 2) return false
  if (PROSE_PUNCTUATION.test(term)) return false
  if (TRAILING_SEPARATOR.test(term)) return false
  if (SEPARATOR_DUMP.test(term)) return false
  if (GENERIC_TERMS.has(term)) return false
  if (!/[\p{L}\p{N}]/u.test(term)) return false
  if (/^\d+$/.test(term)) return false
  if (CJK.test(term)) {
    const cjkChars = (term.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
    if (cjkChars >= 4 && cjkChars * 2 >= term.length && term.length > MAX_CJK_TERM_LENGTH) return false
    return term.replace(/\s+/g, '').length >= 2
  }
  if (term.length < 3) return false
  // A dotted token is kept when it looks like a host, a file, or an API path
  // (`id.tsinghua.edu.cn`, `settings.yaml`, `systemPrompt.section`), and dropped
  // when it is only a bare two-label host tail (`edu.cn`).
  const dots = (term.match(/\./g) ?? []).length
  if (dots > 0 && !/[\s\\/]/.test(term)) {
    if (dots >= 2) return true
    const last = term.slice(term.lastIndexOf('.') + 1)
    if (KNOWN_EXTENSIONS.has(last)) return true
    return !TLDS.has(last)
  }
  return true
}

/** Structural proper nouns inside a text (never free Chinese prose). */
export function extractTerms(text, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 12
  const source = String(text ?? '')
  if (source === '') return []
  const found = []
  const seen = new Set()
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) {
      const candidate = normalizeTerm(match[1] ?? match[0])
      if (seen.has(candidate) || !isUsableTerm(candidate)) continue
      seen.add(candidate)
      found.push(candidate)
      if (found.length >= limit * 3) break
    }
  }
  // Prefer longer (more specific) terms, then keep the cheapest set to match on.
  found.sort((a, b) => b.length - a.length)
  return found.slice(0, limit)
}

/**
 * One-line excerpt used as the injected card body.
 *
 * Only markdown emphasis markers are stripped: angle brackets must survive,
 * because real memories use them as placeholders (`session-<id>`,
 * `~/.dsh/sessions/<工作区转义名>/…`) and stripping them corrupts the text.
 */
export function excerptOf(text, maxChars = 220) {
  const cleaned = String(text ?? '')
    .replace(/[*`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return trimToBudget(cleaned, maxChars)
}

/**
 * Cut to a character budget, preferring a sentence boundary so the card does not
 * end mid-clause. Used both for mechanical excerpts and for model output, which
 * measurably overshoots an instruction-only limit.
 */
export function trimToBudget(text, maxChars) {
  const value = String(text ?? '').trim()
  if (!Number.isFinite(maxChars) || maxChars <= 1 || value.length <= maxChars) return value
  const window = value.slice(0, maxChars)
  const boundary = Math.max(window.lastIndexOf('。'), window.lastIndexOf('；'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('. '), window.lastIndexOf('; '))
  if (boundary >= Math.floor(maxChars * 0.5)) return window.slice(0, boundary + 1).trim()
  return `${window.slice(0, maxChars - 1).trim()}…`
}
