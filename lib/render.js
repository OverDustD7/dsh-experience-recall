// Render one injection block, hard-capped by bytes (SPEC 5.5 / 5.2.1 budget:
// single injection <= 400 token, i.e. comfortably inside ~1.2 KB of Chinese).

const HEADER = '【可能相关的历史经验 · 来自其他项目】'
const FOOTER = '需要细节：用 mnemon_recall / document_search 取全文。'

export function shortId(id) {
  const value = String(id ?? '')
  if (value.startsWith('doc:')) {
    const [documentId, fragment] = value.slice(4).split('#')
    return `doc:${documentId.replace(/-/g, '').slice(0, 8)}${fragment === undefined ? '' : `#${fragment}`}`
  }
  return value.replace(/-/g, '').slice(0, 8)
}

export function cleanExcerpt(text, maxChars) {
  let out = String(text ?? '')
    .replace(/[*`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (maxChars > 1 && out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`
  return out
}

/**
 * @param rows candidates `{ id, excerpt }`
 * @returns the injection text, or undefined when nothing fits the budget
 */
export function renderInjection(rows, options = {}) {
  return renderInjectionResult(rows, options).text
}

/** Return the exact rows that fit, for accurate deduplication and counters. */
export function renderInjectionResult(rows, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 1200
  const maxCards = Number.isFinite(options.maxCards) ? Math.max(1, options.maxCards) : 2
  const excerptChars = Number.isFinite(options.excerptChars) ? options.excerptChars : 260
  const header = `${HEADER}\n`
  const footer = `\n${FOOTER}`
  const budget = maxBytes - Buffer.byteLength(header) - Buffer.byteLength(footer)
  if (budget <= 0) return { text: undefined, rows: [] }
  const lines = []
  const rendered = []
  let used = 0
  for (const row of rows.slice(0, maxCards)) {
    const line = `· ${cleanExcerpt(row.excerpt, excerptChars)}（记忆 id: ${shortId(row.id)}）\n`
    const size = Buffer.byteLength(line)
    if (used + size > budget) break
    lines.push(line)
    rendered.push(row)
    used += size
  }
  if (lines.length === 0) return { text: undefined, rows: [] }
  return { text: `${header}${lines.join('')}${footer}`, rows: rendered }
}
