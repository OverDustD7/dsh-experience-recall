// The live trigger vocabulary.
//
// Seed terms are stable; derived terms are keyed by the memory that owns them, so
// a term hit can inject THAT memory directly (no CLI round trip) and so that a
// memory which changed or was forgotten can drop exactly its own terms.
import { buildTable } from './keywords.js'
import { normalizeTerm } from './terms.js'

export function createTermTable(options = {}) {
  const logger = options.logger
  const maxTerms = Number.isFinite(options.maxTerms) ? options.maxTerms : 6000
  const entries = new Map()
  const byMemory = new Map()
  const alternatives = new Map()
  let compiled
  let derivedCount = 0

  for (const entry of options.seedEntries ?? []) {
    const term = normalizeTerm(entry?.term)
    if (term === '') continue
    entries.set(term, { ...entry, term, source: entry.source ?? 'seed' })
  }

  function invalidate() {
    compiled = undefined
  }

  function add(entry) {
    const term = normalizeTerm(entry?.term)
    if (term === '') return false
    if (typeof entry?.memoryId === 'string' && entry.memoryId !== '') {
      const owners = alternatives.get(term) ?? new Map()
      owners.set(entry.memoryId, { ...entry, term })
      alternatives.set(term, owners)
    }
    if (entries.has(term)) return false
    if (entries.size >= maxTerms) return false
    entries.set(term, { ...entry, term })
    if (typeof entry?.memoryId === 'string' && entry.memoryId !== '') {
      let owned = byMemory.get(entry.memoryId)
      if (owned === undefined) {
        owned = new Set()
        byMemory.set(entry.memoryId, owned)
      }
      owned.add(term)
    }
    derivedCount += 1
    invalidate()
    return true
  }

  function addMany(list) {
    let added = 0
    for (const entry of list ?? []) if (add(entry)) added += 1
    return added
  }

  /** Drop every term owned by one memory (forget / archive / changed memory). */
  function removeMemory(memoryId) {
    const owned = byMemory.get(memoryId)
    for (const [term, owners] of alternatives) {
      owners.delete(memoryId)
      if (owners.size === 0) alternatives.delete(term)
    }
    if (owned === undefined) return 0
    let removed = 0
    for (const term of owned) {
      if (entries.delete(term)) removed += 1
    }
    byMemory.delete(memoryId)
    derivedCount = Math.max(0, derivedCount - removed)
    for (const term of owned) {
      const next = alternatives.get(term)?.values().next().value
      if (next !== undefined) add(next)
    }
    invalidate()
    return removed
  }

  /** Replace all terms of one memory (used when a memory's content changed). */
  function replaceMemory(memoryId, list) {
    const removed = removeMemory(memoryId)
    const added = addMany(list)
    return { removed, added }
  }

  function current() {
    if (compiled === undefined) compiled = buildTable([...entries.values()])
    return compiled
  }

  function stats() {
    return {
      terms: entries.size,
      derived: derivedCount,
      memories: byMemory.size,
      seeds: entries.size - derivedCount,
    }
  }

  function note(record) {
    try {
      logger?.write(record)
    } catch {
      // logging is best effort by contract
    }
  }

  return { add, addMany, removeMemory, replaceMemory, current, stats, note, entries, byMemory }
}
