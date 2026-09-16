// Keeping the trigger vocabulary current.
//
// The user's rule: whenever the memory plugin's own tools are called, tidy up
// what was added / changed / deleted. So every `mnemon_*` tool call schedules a
// reconcile pass that diffs the store against what the table already knows:
//
//   new id          -> add its terms
//   changed revision-> replace exactly that memory's terms
//   missing id      -> drop its terms (forget / archive / soft delete)
//
// Two further filters live here because only this layer sees the whole corpus:
//   * document frequency — a term that appears in most memories ("pwsh", "dsh")
//     discriminates nothing and only produces noise (measured: it fired on every
//     single event of one session);
//   * a periodic lazy check as the safety net for writes that bypass the tools.
import { createTermTable } from './table.js'

const MNEMON_TOOL = /^mnemon_/

export function createMemoryWatch(options = {}) {
  const store = options.store
  const builder = options.builder
  const logger = options.logger
  const config = options.config ?? {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timers = options.timers ?? { setTimeout, clearTimeout }
  const debounceMs = Number.isFinite(config.reconcileDebounceMs) ? config.reconcileDebounceMs : 1500
  const periodMs = Number.isFinite(config.reconcileMs) ? config.reconcileMs : 5 * 60 * 1000
  const dfRatio = Number.isFinite(config.maxTermDocumentFrequency) ? config.maxTermDocumentFrequency : 0.02
  /** Small corpora need a floor, or 2% of 50 cards blocks nothing at all. */
  const ubiquityFloor = Number.isFinite(config.ubiquityFloor) ? Math.max(2, config.ubiquityFloor) : 4
  const table = options.table ?? createTermTable({ seedEntries: [], logger })
  const memories = new Map()
  const documents = new Map()
  const pendingCalls = new Map()
  const blocked = new Set()
  const stats = {
    reconciles: 0,
    added: 0,
    updated: 0,
    removed: 0,
    documents: 0,
    fragments: 0,
    compacted: 0,
    prunedRevisions: 0,
    ubiquityCap: 0,
    ubiquityBlocked: 0,
    revalidated: 0,
    failures: 0,
    blockedTerms: 0,
    lastReason: undefined,
    lastAt: undefined,
    lastError: undefined,
    terms: 0,
    triggers: 0,
  }
  let timer
  let queuedReason
  let running
  let disposed = false

  function log(record) {
    try {
      logger?.write(record)
    } catch {
      // logging is best effort by contract
    }
  }

  function entriesFor(memoryId, built, kind) {
    const excerpt = typeof built?.card === 'string' ? built.card : ''
    return (built?.terms ?? []).map((term) => ({
      term,
      kind,
      source: built?.source ?? 'mechanical',
      memoryId,
      ...(excerpt === '' ? {} : { excerpt }),
    }))
  }

  /** Stage one memory's terms without touching the table yet. */
  async function stageInsights() {
    const result = await store.insights()
    if (result.error !== undefined) {
      stats.failures += 1
      stats.lastError = result.error
      return undefined
    }
    const seen = new Set()
    const staged = []
    for (const row of result.rows) {
      if (disposed) return undefined
      seen.add(row.id)
      const revision = `${row.updatedAt}|${row.content.length}`
      if (memories.get(row.id)?.revision === revision) continue
      const built = await builder.build(row, revision)
      staged.push({ memoryId: row.id, revision, cacheKey: built?.key, entries: entriesFor(row.id, built, 'memory'), isNew: !memories.has(row.id) })
    }
    const removals = [...memories.keys()].filter((id) => !seen.has(id))
    return { staged, removals, live: seen.size }
  }

  /** Stage one document's terms the same way, plus its `##` fragments (SPEC 5.2.4). */
  async function stageDocuments() {
    if (typeof builder.buildDocument !== 'function') return { staged: [], removals: [], live: 0 }
    const result = await store.documents()
    if (result.error !== undefined) {
      stats.failures += 1
      stats.lastError = result.error
      return undefined
    }
    const rows = result.rows
    let bodies
    if (config.documentFragments !== false && typeof builder.buildDocumentFragments === 'function' && typeof store.documentBodies === 'function') {
      try {
        bodies = await store.documentBodies(rows)
      } catch (error) {
        stats.lastError = String(error?.message ?? error)
        log({ kind: 'store', source: 'document-bodies', error: String(error?.message ?? error) })
        return undefined
      }
    }
    const seen = new Set()
    const staged = []
    const seenFragmentIds = new Set()
    for (const row of rows) {
      if (disposed) return undefined
      const memoryId = `doc:${row.id}`
      seen.add(memoryId)
      const revision = `${row.updatedAt}|${row.description.length}`
      if (documents.get(memoryId)?.revision !== revision) {
        const built = builder.buildDocument(row, revision)
        staged.push({ memoryId, revision, cacheKey: built?.key, entries: entriesFor(memoryId, built, 'document'), isNew: !documents.has(memoryId) })
      }
      const text = bodies === undefined ? undefined : bodies.get(row.id)
      if (bodies !== undefined && row.relativePath && text === undefined) {
        stats.lastError = `unreadable document body: ${row.id}`
        return undefined
      }
      if (typeof text !== 'string' || text === '') continue
      const fragmentRevision = `${row.updatedAt}|${text.length}`
      for (const fragment of builder.buildDocumentFragments(row, text, fragmentRevision)) {
        seen.add(fragment.memoryId)
        seenFragmentIds.add(fragment.memoryId)
        if (documents.get(fragment.memoryId)?.revision === fragmentRevision) continue
        staged.push({
          memoryId: fragment.memoryId,
          revision: fragmentRevision,
          cacheKey: fragment.key,
          entries: entriesFor(fragment.memoryId, fragment, 'document'),
          isNew: !documents.has(fragment.memoryId),
        })
      }
    }
    const removals = [...documents.keys()].filter((id) => !seen.has(id))
    // `live` counts informational units (documents), not fragments: the document
    // frequency filter must not be diluted by how finely a file was split.
    return { staged, removals, live: rows.length, fragments: seenFragmentIds.size }
  }
  /**
   * A term carried by a large share of the corpus cannot discriminate: it fires
   * on every event and drags an arbitrary card in. Drop those before they reach
   * the table, and prune them from the persisted cache so the dynamic runtime
   * (which reads only the cache) inherits the same filtering.
   *
   * Two measured corrections over the first version:
   *   1. the denominator is the number of cards the vocabulary actually holds
   *      (memories + documents + `##` fragments), not memories + documents — with
   *      1082 cards and a memories-only denominator the cap was ~7x too loose;
   *   2. the frequency is counted over the whole cache, not just the staging
   *      batch. The staging batch only contains what changed, so a term that had
   *      become ubiquitous after the fact was never re-examined (`pwsh`/`dsh`).
   */
  function filterUbiquitous(staged, corpusSize) {
    if (!(dfRatio > 0)) return { staged, cap: 0, blocked: 0 }
    if (corpusSize < ubiquityFloor) return { staged, cap: 0, blocked: 0 }
    const cap = Math.max(ubiquityFloor, Math.floor(corpusSize * dfRatio))
    const df = new Map()
    const count = (term) => df.set(term, (df.get(term) ?? 0) + 1)
    // Count the whole persisted corpus, then add only the staged cards that are
    // not in it yet — otherwise every rebuilt-on-this-pass card is counted twice
    // and the frequency is inflated exactly where the decision is close.
    const current = new Map()
    for (const registry of [memories, documents]) {
      for (const [id, record] of registry) current.set(id, record.entries ?? [])
    }
    for (const group of staged) {
      current.set(group.memoryId, group.entries)
    }
    for (const entries of current.values()) for (const term of new Set(entries.map((entry) => entry.term))) count(term)
    const ubiquitous = new Set()
    for (const [term, value] of df) if (value > cap) ubiquitous.add(term)
    if (ubiquitous.size === 0) return { staged, cap, blocked: 0 }
    for (const term of ubiquitous) blocked.add(term)
    stats.blockedTerms = blocked.size
    log({ kind: 'terms', phase: 'ubiquity-filter', cap, corpusSize, blocked: ubiquitous.size, sample: [...ubiquitous].slice(0, 12) })
    if (typeof builder.prune === 'function') builder.prune((term) => blocked.has(term))
    for (const [id, entries] of current) table.replaceMemory(id, entries.filter((entry) => !blocked.has(entry.term)))
    // Keep every group (with its terms filtered) rather than dropping whole
    // groups: a dropped group would skip `table.replaceMemory`, leaving the term
    // it just blocked sitting in the live vocabulary.
    return { staged: staged.map((group) => ({ ...group, entries: group.entries.filter((entry) => !blocked.has(entry.term)) })), cap, blocked: ubiquitous.size }
  }

  /** Every distinct term currently persisted in the card cache. */
  function cacheTermsOf() {
    if (typeof builder.cachedTerms === 'function') return builder.cachedTerms()
    return []
  }

  /** Number of cards currently persisted (the ubiquity denominator). */
  function cachedSize() {
    const stats = typeof builder.stats === 'function' ? builder.stats() : undefined
    return Number.isFinite(stats?.cache) ? stats.cache : 0
  }

  /**
   * Document frequency of every term in the live corpus, for observability: the
   * verdict logs record it so "is this term discriminative?" becomes answerable
   * without re-running the indexer. `cachedTerms()` already dedupes within one
   * card, so counting occurrences yields the number of cards carrying each term.
   */
  function documentFrequency() {
    const df = new Map()
    for (const term of cacheTermsOf()) df.set(term, (df.get(term) ?? 0) + 1)
    return df
  }

  /** The revision each live memory / document / fragment is currently declared at. */
  function declaredLive() {
    const live = new Map()
    for (const registry of [memories, documents]) {
      for (const [memoryId, record] of registry) {
        const revision = String(record?.revision ?? '')
        // Two revisions may be declared for one id when a document changed within
        // one reconcile; the newest key sorts last on the disk index either way.
        const present = live.get(memoryId)
        if (present === undefined || revision > present) live.set(memoryId, revision)
      }
    }
    return live
  }

  function applyStaged(staged) {
    let added = 0
    let updated = 0
    for (const group of staged) {
      const entries = group.entries.filter((entry) => !blocked.has(entry.term))
      if (group.isNew) {
        table.addMany(entries)
        added += 1
      } else {
        table.replaceMemory(group.memoryId, entries)
        updated += 1
      }
      const registry = group.memoryId.startsWith('doc:') ? documents : memories
      registry.set(group.memoryId, { revision: group.revision, terms: entries.length, entries })
    }
    return { added, updated }
  }

  /** Full diff of the store against the live table. Never throws. */
  async function reconcile(reason = 'manual') {
    if (disposed) return
    if (running !== undefined) {
      queuedReason = reason
      return running
    }
    running = (async () => {
      try {
        if (typeof builder.load === 'function') await builder.load()
        // A card is keyed by `id:revision`, so a revision that did not change keeps
        // the terms it was built with. Tightening the term rules must therefore
        // re-validate the cache too, or the old vocabulary stays live.
        if (typeof builder.revalidate === 'function') stats.revalidated = builder.revalidate()
        const insights = await stageInsights()
        if (disposed || insights === undefined) return
        const docs = await stageDocuments()
        if (disposed) return
        if (docs === undefined) {
          stats.failures += 1
        } else {
          // The ubiquity denominator is what the vocabulary actually holds: every
          // memory plus every document and every `##` fragment. Fragments are the
          // majority of the corpus, so ignoring them made the cap far too loose.
          //
          // Order matters: staging is what writes newly built cards into the
          // builder cache, so the frequency count must run after it. Counting first
          // is how a term that had become ubiquitous was missed twice over — the
          // cache only held the previous corpus and the new cards were not in it.
          // `cachedSize()` reads the builder cache, which staging has just filled.
          for (const id of [...insights.removals, ...docs.removals]) {
            table.removeMemory(id)
            memories.delete(id)
            documents.delete(id)
            stats.removed += 1
          }
          const corpus = (insights.live ?? 0) + (docs.live ?? 0) + (docs.fragments ?? 0)
          const filtered = filterUbiquitous([...insights.staged, ...docs.staged], corpus)
          const applied = applyStaged(filtered.staged)
          stats.added += applied.added
          stats.updated += applied.updated
          stats.ubiquityCap = filtered.cap
          stats.ubiquityBlocked = filtered.blocked
          stats.compacted = 0
          stats.prunedRevisions = 0
          stats.documents = docs.live ?? documents.size
          stats.fragments = docs.fragments ?? 0
          if (typeof builder.enforceRevisionBudget === 'function') stats.prunedRevisions = builder.enforceRevisionBudget()
          if (typeof builder.compact === 'function') stats.compacted = builder.compact(declaredLive())
          if (typeof builder.save === 'function') await builder.save()
          stats.reconciles += 1
          stats.lastReason = reason
          stats.lastAt = now()
          stats.terms = table.stats().terms
          log({
            kind: 'terms',
            phase: 'reconcile',
            reason,
            memories: insights.live ?? memories.size,
            documents: docs.live ?? documents.size,
            fragments: docs.fragments ?? 0,
            added: applied.added,
            updated: applied.updated,
            removed: stats.removed,
            blocked: blocked.size,
            ubiquityCap: stats.ubiquityCap,
            compacted: stats.compacted,
            prunedRevisions: stats.prunedRevisions,
            table: table.stats(),
            builder: typeof builder.stats === 'function' ? builder.stats() : undefined,
          })
        }
      } catch (error) {
        stats.failures += 1
        stats.lastError = String(error?.message ?? error)
        log({ kind: 'error', where: 'reconcile', message: stats.lastError })
      } finally {
        running = undefined
        const next = queuedReason
        queuedReason = undefined
        if (!disposed && next !== undefined) void reconcile(next)
      }
    })()
    return running
  }

  function schedule(reason, delayMs = debounceMs) {
    if (disposed) return
    if (timer !== undefined) {
      if (reason !== 'tool-call') return
      timers.clearTimeout(timer)
    }
    timer = timers.setTimeout(() => {
      timer = undefined
      void reconcile(reason)
    }, Math.max(0, delayMs))
    if (typeof timer?.unref === 'function') timer.unref()
  }

  /** Feed every session event; only mnemon tool traffic is acted on. */
  function observe(event, sessionId = '') {
    try {
      if (disposed) return
      const type = typeof event?.type === 'string' ? event.type : ''
      if (type === 'tool/call') {
        const name = typeof event.data?.name === 'string' ? event.data.name : ''
        if (!MNEMON_TOOL.test(name)) return
        pendingCalls.set(JSON.stringify([sessionId, event.data?.turn, event.data?.step, event.data?.callId]), name)
        if (pendingCalls.size > 512) pendingCalls.delete(pendingCalls.keys().next().value)
        stats.triggers += 1
        schedule('tool-call', debounceMs)
        return
      }
      if (type === 'tool/result') {
        const callId = JSON.stringify([sessionId, event.data?.turn, event.data?.step, event.data?.message?.source?.callId])
        if (!pendingCalls.has(callId)) return
        pendingCalls.delete(callId)
        schedule('tool-result', debounceMs)
        return
      }
      if (now() - (stats.lastAt ?? 0) > periodMs) schedule('periodic', 0)
    } catch (error) {
      stats.failures += 1
      log({ kind: 'error', where: 'watch.observe', message: String(error?.message ?? error) })
    }
  }

  function dispose() {
    disposed = true
    queuedReason = undefined
    pendingCalls.clear()
    if (timer !== undefined) {
      timers.clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    table,
    observe,
    reconcile,
    schedule,
    dispose,
    documentFrequency,
    snapshot: () => ({
      ...stats,
      memories: memories.size,
      documents: documents.size,
      pending: pendingCalls.size,
      blockedTerms: blocked.size,
      table: table.stats(),
      builder: typeof builder.stats === 'function' ? builder.stats() : undefined,
    }),
  }
}
