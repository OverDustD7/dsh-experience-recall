// Stage P1 observer: read session events, scan the text that matters, log.
//
// This module deliberately contains no retrieval and no injection. It exists to
// produce the evidence the later stages are designed against:
//   * which event types actually arrive, including any live-only ones;
//   * how much reasoning / tool-argument / tool-result text there is to scan;
//   * which seed keywords really hit, with a mechanical context window;
//   * how long sits between a tool call event and its result event (SPEC Q6).
import { buildTable, matchKeywords, mergeTables, SEED_KEYWORDS } from './keywords.js'
import { segmentsOfEvent, toolCallKey } from './scan.js'

const MAX_PENDING_CALLS = 512

export function createObserver(options = {}) {
  const logger = options.logger
  const config = options.config ?? {}
  const contextChars = Number.isFinite(config.contextChars) ? config.contextChars : 60
  const maxSegmentChars = Number.isFinite(config.maxSegmentChars) ? config.maxSegmentChars : 200000
  const statsEvery = Number.isFinite(config.statsEvery) && config.statsEvery > 0 ? config.statsEvery : 200
  // A compiled table, or a function returning the current one: the vocabulary is
  // live (new memories arrive while the session runs), so it is resolved per event.
  const tableSource = options.table ?? mergeTables(buildTable(SEED_KEYWORDS), options.extraKeywords ?? [])
  const onHits = typeof options.onHits === 'function' ? options.onHits : null

  const counters = {
    events: 0,
    segments: 0,
    chars: 0,
    hits: 0,
    truncated: 0,
    failures: 0,
    byType: new Map(),
    byTerm: new Map(),
  }
  const pendingCalls = new Map()

  function log(record) {
    try {
      logger?.write(record)
    } catch {
      // logging is best effort by contract
    }
  }

  function snapshot() {
    return {
      events: counters.events,
      segments: counters.segments,
      chars: counters.chars,
      hits: counters.hits,
      truncated: counters.truncated,
      failures: counters.failures,
      byType: Object.fromEntries(counters.byType),
      byTerm: Object.fromEntries([...counters.byTerm.entries()].sort((a, b) => b[1] - a[1])),
    }
  }

  function maybeStats(session) {
    if (counters.events > 0 && counters.events % statsEvery === 0) log({ kind: 'stats', session, ...snapshot() })
  }

  function trackCall(event, data, session) {
    if (event.type === 'tool/call') {
      pendingCalls.set(JSON.stringify([session, toolCallKey(data)]), {
        name: typeof data.name === 'string' ? data.name : '',
        time: Number(event.time),
      })
      while (pendingCalls.size > MAX_PENDING_CALLS) {
        const oldest = pendingCalls.keys().next().value
        pendingCalls.delete(oldest)
      }
      return
    }
    if (event.type !== 'tool/result') return
    const key = JSON.stringify([session, toolCallKey(data)])
    const call = pendingCalls.get(key)
    if (call === undefined) return
    pendingCalls.delete(key)
    const time = Number(event.time)
    if (!Number.isFinite(time) || !Number.isFinite(call.time)) return
    log({ kind: 'timing', session, seq: event.seq, name: call.name, toolMs: time - call.time })
  }

  /** Observe one durable session event. Never throws. */
  function observe(event, meta = {}) {
    try {
      if (event === null || typeof event !== 'object') return
      const type = typeof event.type === 'string' ? event.type : 'unknown'
      const session = typeof meta.sessionId === 'string' ? meta.sessionId : undefined
      // The live Session object (not the id) is what surface visibility needs.
      const sessionRef = meta.sessionRef
      counters.events += 1
      counters.byType.set(type, (counters.byType.get(type) ?? 0) + 1)

      const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
      if (data !== undefined) trackCall(event, data, session)

      const segments = segmentsOfEvent(event)
      if (segments.length === 0) {
        maybeStats(session)
        return
      }

      const summary = []
      const hits = []
      let hitText = ''
      for (const segment of segments) {
        const text = typeof segment.text === 'string' ? segment.text : ''
        const scanned = text.length > maxSegmentChars ? text.slice(0, maxSegmentChars) : text
        if (scanned.length !== text.length) counters.truncated += 1
        counters.segments += 1
        counters.chars += scanned.length
        summary.push({ kind: segment.kind, chars: text.length, ...(segment.fromStream === true ? { fromStream: true } : {}) })
        // Never trigger on our own injected messages or host system text.
        if (segment.kind === 'plugin-message' || segment.kind === 'system') continue
        hitText = `${hitText}\n${scanned}`.slice(-2000).trim()
        const activeTable = typeof tableSource === 'function' ? tableSource() : tableSource
        const found = matchKeywords(scanned, activeTable, { contextChars })
        if (found.length === 0) continue
        hits.push(...found)
        counters.hits += found.length
        for (const hit of found) counters.byTerm.set(hit.term, (counters.byTerm.get(hit.term) ?? 0) + 1)
        // The relevance gate judges against what the session is doing, so the
        // text that produced the hit is handed to the controller as context.
      }

      log({
        kind: 'event',
        session,
        seq: event.seq,
        type,
        turn: data?.turn,
        step: data?.step,
        segments: summary,
        ...(hits.length > 0 ? { hits } : {}),
      })
      if (hitText !== '' && onHits !== null) {
        try {
          onHits(hits, {
            ...meta,
            sessionId: session,
            sessionRef,
            agentId: meta.agentId,
            turn: data?.turn,
            step: data?.step,
            type,
            text: hitText.slice(-2000),
          })
        } catch (error) {
          counters.failures += 1
          log({ kind: 'error', where: 'onHits', message: String(error?.message ?? error) })
        }
      }
      maybeStats(session)
    } catch (error) {
      counters.failures += 1
      log({ kind: 'error', where: 'observe', message: String(error?.message ?? error) })
    }
  }

  /** Observe an `agent/pre-step` boundary: the future injection point (P2). */
  function observePreStep(payload, meta = {}) {
    try {
      const session = typeof meta.sessionId === 'string' ? meta.sessionId : undefined
      const messages = Array.isArray(payload?.messages) ? payload.messages.length : undefined
      log({
        kind: 'prestep',
        session,
        turn: payload?.turn,
        step: payload?.step,
        messages,
        aborted: payload?.signal?.aborted === true,
      })
    } catch (error) {
      counters.failures += 1
      log({ kind: 'error', where: 'observePreStep', message: String(error?.message ?? error) })
    }
  }

  function note(kind, meta = {}) {
    log({ kind, ...meta })
  }

  function flush(session) {
    log({ kind: 'stats', final: true, session, ...snapshot() })
    return typeof logger?.flush === 'function' ? logger.flush() : Promise.resolve()
  }

  return { observe, observePreStep, note, flush, snapshot, table: tableSource }
}
