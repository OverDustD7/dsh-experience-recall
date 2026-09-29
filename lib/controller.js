// Controller: gates, asynchronous retrieval, the local-model relevance gate, and
// boundary injection.
//
// Design contract (SPEC 5.3.2): the boundary never waits. A trigger starts a
// fire-and-forget recall followed by a fire-and-forget relevance judgement; if
// the answer is not ready when the next step begins, the step simply proceeds
// and the answer is offered at the following boundary.
//
// Stages and gates (SPEC 5.1.1 / 5.4), all per session:
//   1. mechanical match -> curated trigger table (no model, no tokens);
//   2. local-model relevance judgement -> only `useful` candidates continue
//      (measured: median 292 ms warm, serialized so calls never stack);
//   3. dedup   -> same term once per turn, same memory once per turn, same
//                 memory once per session while it is still visible;
//   4. quota   -> at most one injection per step, `maxInjectionsPerTurn` per
//                 turn, one recall in flight, cooldown per term.
import { randomUUID } from 'node:crypto'
import { PLUGIN_NAME } from './config.js'
import { renderInjectionResult } from './render.js'
import { messageVisibleInSurface } from './surface.js'

/** Candidates that may be judged from one event (derived hits are free). */
const MAX_CANDIDATES_PER_EVENT = 2
const QUERY_CONTEXT_CHARS = 160

function createPluginMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:' + PLUGIN_NAME, form: 'recall' },
  }
}

export function createController(options = {}) {
  const config = options.config ?? {}
  const logger = options.logger
  const recall = options.recall
  const verifier = options.verify ?? { verify: async () => ({ useful: true, skipped: true, why: 'no verifier', ms: 0 }) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const minScore = Number.isFinite(config.minScore) ? config.minScore : 0
  const cooldownMs = Number.isFinite(config.cooldownMs) ? config.cooldownMs : 0
  const maxInjectionsPerTurn = Number.isFinite(config.maxInjectionsPerTurn) ? config.maxInjectionsPerTurn : 3
  const maxCards = Number.isFinite(config.maxCardsPerInjection) ? config.maxCardsPerInjection : 2
  const maxInjectBytes = Number.isFinite(config.maxInjectBytes) ? config.maxInjectBytes : 1200
  const timeoutMs = Number.isFinite(config.recallTimeoutMs) ? config.recallTimeoutMs : 5000
  const verifyContextChars = Number.isFinite(config.verifyContextChars) ? config.verifyContextChars : 700
  const semanticEnabled = config.semanticFallback !== false
  const semanticEverySteps = Number.isFinite(config.semanticEverySteps) ? Math.max(1, config.semanticEverySteps) : 5
  const semanticMinChars = Number.isFinite(config.semanticMinChars) ? config.semanticMinChars : 60
  const semanticCooldownMs = Number.isFinite(config.semanticCooldownMs) ? config.semanticCooldownMs : 120000
  /** A memory still in the surface but this many tokens behind the tail counts as
   * effectively forgotten, so it may be injected again (SPEC 5.4.2). */
  const reinjectTokenDistance = Number.isFinite(config.reinjectTokenDistance) ? config.reinjectTokenDistance : 20000
  /** A term the judge keeps rejecting (and never accepts) earns a long cooldown:
   * measured noise terms otherwise cost one local model call per event. */
  const termRejectLimit = Number.isFinite(config.termRejectLimit) ? config.termRejectLimit : 3
  const termBlockCooldownMs = Number.isFinite(config.termBlockCooldownMs) ? config.termBlockCooldownMs : 1800000
  /** Repeated identical tool calls mean the model is going in circles. */
  const repeatToolLimit = Number.isFinite(config.repeatToolLimit) ? config.repeatToolLimit : 3
  const repeatWindowSteps = Number.isFinite(config.repeatWindowSteps) ? config.repeatWindowSteps : 12
  const surfaceDistance = typeof options.surfaceDistance === 'function' ? options.surfaceDistance : null
  /** How many retrieved rows per recall to record (scores only) for threshold work. */
  const scoreLogLimit = Number.isFinite(config.scoreLogLimit) ? Math.max(0, config.scoreLogLimit) : 5
  /**
   * Optional `(term) => ({ kind, source, df })` lookup so every verdict can say
   * WHICH half of the vocabulary produced it. Without it the logs cannot answer
   * "are the 700 document fragments earning their keep?".
   */
  const cardMeta = typeof options.cardMeta === 'function' ? options.cardMeta : null
  const sessions = new Map()
  const skipped = new Map()
  const termLedger = new Map()
  const stats = { hits: 0, recalls: 0, direct: 0, semantic: 0, accepted: 0, rejected: 0, inconclusive: 0, verifySkipped: 0, queued: 0, injected: 0, cards: 0, bytes: 0, failures: 0, lastAccepted: '', termCooldowns: 0, reinjectFar: 0, repeatTriggers: 0, unreadableWindows: 0, bySource: {} }
  let verifyChain = Promise.resolve()
  let verifyQueued = 0
  let disposed = false

  function log(record) {
    try {
      logger?.write(record)
    } catch {
      // best effort by contract
    }
  }

  function skip(reason) {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
  }

  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        turn: undefined,
        turnKeywords: new Set(),
        turnMemoryIds: new Set(),
        injections: 0,
        lastInjectionStep: undefined,
        lastTermAt: new Map(),
        injected: new Map(),
        pending: [],
        inflight: new Set(),
        recallsInFlight: 0,
        recent: '',
        lastSemanticAt: undefined,
        lastSemanticStep: undefined,
        toolSignatures: new Map(),
        repeatStep: undefined,
        generation: 0,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function noteTurn(state, turn) {
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return
    if (state.turn === turn) return
    if (state.turn !== undefined) {
      state.generation += 1
      state.pending.length = 0
      state.recent = ''
    }
    state.turn = turn
    state.turnKeywords.clear()
    state.turnMemoryIds.clear()
    state.injections = 0
    state.lastInjectionStep = undefined
    state.lastSemanticStep = undefined
    state.toolSignatures.clear()
  }

  function buildQuery(hit) {
    const context = typeof hit.context === 'string' ? hit.context.replace(/\s+/g, ' ').slice(0, QUERY_CONTEXT_CHARS) : ''
    return `${hit.term} ${context}`.trim()
  }

  /**
   * Is this memory effectively still in front of the model?
   * "Present in the surface" is not enough: in a long session an injection can sit
   * tens of thousands of tokens behind the tail and no longer influence anything
   * (SPEC 5.4.2 — the "too far" criterion). The distance comes from token-meter
   * through a callback, and a service-less host simply keeps the old behaviour.
   */
  function memoryStillVisible(sessionRef, state, memoryId) {
    const record = state.injected.get(memoryId)
    if (record === undefined) return false
    const visible = messageVisibleInSurface(sessionRef, (messageId) => messageId === record.messageId)
    if (!visible) return false
    if (surfaceDistance === null || reinjectTokenDistance <= 0) return true
    try {
      const distance = surfaceDistance(sessionRef, record.messageId)
      if (typeof distance !== 'number' || !Number.isFinite(distance)) return true
      if (distance > reinjectTokenDistance) {
        stats.reinjectFar += 1
        log({ kind: 'visibility', outcome: 'too-far', card: String(memoryId).slice(0, 8), distance, threshold: reinjectTokenDistance })
        return false
      }
      return true
    } catch {
      return true
    }
  }

  /**
   * Vocabulary reputation, learned from the judge's own verdicts: a term that gets
   * rejected repeatedly and never accepted is not worth a model call per event.
   * It is a long cooldown, not a permanent block, so it can recover.
   */
  function termCooling(term, when) {
    const ledger = termLedger.get(term)
    if (ledger === undefined || ledger.rejected < termRejectLimit) return false
    if (ledger.accepted > 0) return false
    const until = ledger.lastRejectedAt + termBlockCooldownMs
    if (when >= until) {
      ledger.rejected = 0
      return false
    }
    return true
  }

  function noteTermVerdict(term, useful, when) {
    let ledger = termLedger.get(term)
    if (ledger === undefined) {
      ledger = { accepted: 0, rejected: 0, lastRejectedAt: 0 }
      termLedger.set(term, ledger)
    }
    if (useful) {
      ledger.accepted += 1
    } else {
      ledger.rejected += 1
      ledger.lastRejectedAt = when
      if (ledger.rejected === termRejectLimit && ledger.accepted === 0) {
        stats.termCooldowns += 1
        log({ kind: 'term-cooldown', term, rejected: ledger.rejected, cooldownMs: termBlockCooldownMs })
      }
    }
  }

  /**
   * Repetition detection (SPEC §5.4.2, the "the model is going in circles" signal):
   * the same tool call repeated in a short window is exactly the situation where a
   * past experience is most likely to unstick it.
   */
  function noteToolCall(meta = {}) {
    try {
      const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined
      const name = typeof meta.name === 'string' ? meta.name : ''
      if (sessionId === undefined || name === '' || name.startsWith('experience_')) return
      const signature = `${name} ${String(meta.arguments ?? '').replace(/\s+/g, ' ').slice(0, 200)}`
      const state = stateOf(sessionId)
      if (disposed) return
      noteTurn(state, meta.turn)
      const step = Number.isFinite(meta.step) ? meta.step : undefined
      if (step !== undefined && state.repeatStep !== undefined && step - state.repeatStep > repeatWindowSteps) {
        state.toolSignatures.clear()
      }
      state.repeatStep = step ?? state.repeatStep
      const previous = state.toolSignatures.get(signature) ?? []
      const steps = previous.filter((at) => step === undefined || (at !== undefined && step >= at && step - at <= repeatWindowSteps))
      steps.push(step)
      const seen = steps.length
      state.toolSignatures.set(signature, steps)
      if (state.toolSignatures.size > 200) {
        const oldest = state.toolSignatures.keys().next().value
        state.toolSignatures.delete(oldest)
      }
      if (seen < repeatToolLimit) return
      state.toolSignatures.set(signature, [])
      stats.repeatTriggers += 1
      log({ kind: 'repeat-detected', session: sessionId, tool: name, times: seen })
      maybeSemanticFallback({ ...meta, sessionId, reason: 'repeat-tool', force: true })
    } catch (error) {
      stats.failures += 1
      log({ kind: 'error', where: 'noteToolCall', message: String(error?.message ?? error) })
    }
  }

  /** Evaluate one event's keyword hits. Returns immediately; recall runs async. */
  function handleHits(hits, meta = {}) {
    try {
      if (disposed || !Array.isArray(hits)) return
      stats.hits += hits.length
      const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined
      if (sessionId === undefined) return
      const state = stateOf(sessionId)
      noteTurn(state, meta.turn)
      // The relevance gate judges against what the session is actually doing, so
      // the recent reasoning/body text is kept per session.
      if (typeof meta.text === 'string' && meta.text !== '') {
        state.recent = `${state.recent}\n${meta.text}`.slice(-verifyContextChars)
      }
      const context = state.recent
      meta = { ...meta, generation: state.generation }
      // Collect every hit that passes the cheap gates, then rank by term length:
      // a longer term is the more specific statement of what is going on. Picking
      // the first hit in scan order instead once chose `pwsh` (a term every memory
      // carries) over `统一身份认证`, and the judge correctly threw it away.
      const eligible = []
      for (const hit of hits) {
        const term = typeof hit?.term === 'string' ? hit.term : ''
        if (term === '') continue
        if (state.turnKeywords.has(term)) {
          skip('keyword-seen-this-turn')
          continue
        }
        if (cooldownMs > 0 && now() - (state.lastTermAt.get(term) ?? 0) < cooldownMs) {
          skip('cooldown')
          continue
        }
        // A term the judge keeps rejecting is not worth another model call.
        if (termCooling(term, now())) {
          skip('term-cooldown')
          continue
        }
        if (state.injections >= maxInjectionsPerTurn) {
          skip('turn-quota')
          return
        }
        eligible.push(hit)
      }
      if (eligible.length === 0) return
      eligible.sort((a, b) => String(b.term ?? '').length - String(a.term ?? '').length)

      let processed = 0
      let seedUsed = false
      for (const hit of eligible) {
        if (processed >= MAX_CANDIDATES_PER_EVENT) break
        const term = String(hit.term)
        // A term derived from a memory carries that memory's card, so the
        // candidate is already known: no CLI round trip, no latency at all.
        // It still has to pass the local-model judgement.
        const direct = typeof hit.memoryId === 'string' && hit.memoryId !== '' && typeof hit.excerpt === 'string' && hit.excerpt !== ''
        if (direct) {
          state.turnKeywords.add(term)
          state.lastTermAt.set(term, now())
          stats.direct += 1
          queueVerify(() => verifyThenEnqueue(state, term, [{ id: hit.memoryId, excerpt: hit.excerpt }], context, meta))
          processed += 1
          continue
        }
        // At most one CLI-backed candidate per event.
        if (seedUsed) continue
        if (state.recallsInFlight >= 1) {
          skip('busy')
          continue
        }
        if (state.pending.length > 0) {
          skip('queued')
          continue
        }
        seedUsed = true
        state.turnKeywords.add(term)
        state.lastTermAt.set(term, now())
        startRecall(state, term, buildQuery(hit), meta, hit, context)
        processed += 1
      }
    } catch (error) {
      stats.failures += 1
      log({ kind: 'error', where: 'handleHits', message: String(error?.message ?? error) })
    }
  }

  /** Judgements are serialized: one local model call at a time, never dropped. */
  function queueVerify(job) {
    if (disposed || verifyQueued >= 32) {
      skip('verify-queue-full')
      return Promise.resolve()
    }
    verifyQueued += 1
    verifyChain = verifyChain.then(job).catch((error) => {
      stats.failures += 1
      log({ kind: 'error', where: 'verifyChain', message: String(error?.message ?? error) })
    }).finally(() => { verifyQueued -= 1 })
    return verifyChain
  }

  /** Second stage: only a candidate the local model calls useful may be queued. */
  async function verifyThenEnqueue(state, term, rows, context, meta) {
    if (!isCurrent(state, meta) || state.injections >= maxInjectionsPerTurn) return
    for (const row of rows) {
      await verifyRow(state, term, row, context, meta)
    }
  }

  function isCurrent(state, meta) {
    return !disposed && sessions.get(meta?.sessionId) === state && state.generation === meta?.generation
  }

  async function verifyRow(state, term, row, context, meta) {
    if (!isCurrent(state, meta) || state.injections >= maxInjectionsPerTurn) return
    if (row === undefined) return
    if (state.turnMemoryIds.has(row.id) || state.pending.some((item) => item.id === row.id)) {
      skip('queued')
      return
    }
    if (memoryStillVisible(meta?.sessionRef, state, row.id)) {
      skip('already-in-context')
      return
    }
    const verdict = await verifier.verify(context, row.excerpt)
    if (!isCurrent(state, meta) || state.injections >= maxInjectionsPerTurn) return
    const meta0 = cardInfoOf(term)
    // The judge reports it had nothing readable to judge against. Recorded, not
    // acted on: the rejected text heuristic showed the condition cannot be detected
    // cheaply from the outside, so the model is asked instead (DEV_NOTES 4.9.7).
    if (verdict.readable === false) {
      stats.unreadableWindows += 1
      log({ kind: 'recall', phase: 'unreadable-window', session: meta?.sessionId, term, useful: verdict.useful === true, why: verdict.why })
    }
    if (verdict.skipped === true) {
      stats.verifySkipped += 1
    } else if (verdict.inconclusive === true) {
      // The judge could not answer (model loading / unreachable / garbage output).
      // That is not a verdict: it must not damage the term's reputation, and the
      // report must not count it as a rejection — hence the explicit flag.
      stats.inconclusive += 1
      log({ kind: 'recall', phase: 'rejected', inconclusive: true, session: meta?.sessionId, term, ...meta0, why: verdict.why, ms: verdict.ms })
      return
    } else if (verdict.useful !== true) {
      stats.rejected += 1
      noteTermVerdict(term, false, now())
      log({ kind: 'recall', phase: 'rejected', session: meta?.sessionId, term, ...meta0, why: verdict.why, ms: verdict.ms })
      return
    } else {
      stats.accepted += 1
      noteTermVerdict(term, true, now())
      stats.lastAccepted = `${term} → ${String(row.id).slice(0, 8)}`
      const bucket = `${meta0.termKind ?? '?'}/${meta0.source ?? '?'}`
      stats.bySource[bucket] = (stats.bySource[bucket] ?? 0) + 1
    }
    state.pending.push(row)
    stats.queued += 1
    log({ kind: 'recall', phase: 'queued', session: meta?.sessionId, term, ...meta0, card: { id: row.id, score: row.score }, verdict: verdict.why })
  }

  /** Which half of the vocabulary a term came from (termKind / source / document frequency). */
  function cardInfoOf(term) {
    if (cardMeta === null) return {}
    try {
      const value = cardMeta(term)
      if (value === null || typeof value !== 'object') return {}
      // `termKind`, not `kind`: spreading `{ kind }` into a log record would
      // overwrite the record's own `kind` field.
      return {
        ...(typeof value.termKind === 'string' ? { termKind: value.termKind } : {}),
        ...(typeof value.source === 'string' ? { source: value.source } : {}),
        ...(typeof value.df === 'number' ? { df: value.df } : {}),
      }
    } catch {
      return {}
    }
  }

  function startRecall(state, term, query, meta, hit, context) {
    if (recall === undefined || typeof recall.query !== 'function') return
    state.inflight.add(term)
    state.recallsInFlight += 1
    stats.recalls += 1
    log({ kind: 'trigger', session: meta.sessionId, turn: meta.turn, step: meta.step, term, kindOfTerm: hit?.kind, query: query.slice(0, 160) })
    void Promise.resolve()
      .then(() => isCurrent(state, meta) ? recall.query(query, { timeoutMs }) : { rows: [] })
      .then((result) => {
        state.inflight.delete(term)
        state.recallsInFlight = Math.max(0, state.recallsInFlight - 1)
        if (!isCurrent(state, meta)) return
        const rows = Array.isArray(result?.rows) ? result.rows : []
        const scored = rows.filter((row) => typeof row?.score !== 'number' || row.score >= minScore)
        // Record the score distribution, not just the surviving rows: `minScore`
        // (0.35) has never once produced a `below-min-score` skip, so the only way
        // to price that threshold is to look at the numbers the CLI returns
        // (scores only — no content), including the ones it discarded.
        if (scoreLogLimit > 0 && rows.length > 0) {
          log({
            kind: 'recall',
            phase: 'scores',
            session: meta.sessionId,
            term,
            rows: rows.length,
            above: scored.length,
            scores: rows.map((row) => (typeof row?.score === 'number' ? row.score : null)).slice(0, scoreLogLimit),
          })
        }
        // A memory already injected this turn is spent; one injected earlier is
        // re-eligible only once it is no longer visible in the surface
        // (compaction or a rewind replaced it) — SPEC 5.4.1.
        const fresh = []
        for (const row of scored) {
          if (state.turnMemoryIds.has(row.id)) {
            skip('memory-seen-this-turn')
            continue
          }
          if (state.pending.some((item) => item.id === row.id)) {
            skip('queued')
            continue
          }
          if (memoryStillVisible(meta.sessionRef, state, row.id)) {
            skip('already-in-context')
            continue
          }
          fresh.push(row)
        }
        if (fresh.length === 0) {
          if (rows.length === 0) skip('no-candidate')
          else if (scored.length === 0) skip('below-min-score')
          log({ kind: 'recall', phase: 'dropped', session: meta.sessionId, term, rows: rows.length, kept: 0 })
          return
        }
        return queueVerify(() => verifyThenEnqueue(state, term, fresh.slice(0, maxCards), context, meta))
      })
      .catch((error) => {
        state.inflight.delete(term)
        state.recallsInFlight = Math.max(0, state.recallsInFlight - 1)
        stats.failures += 1
        log({ kind: 'error', where: 'recall', message: String(error?.message ?? error) })
      })
  }

  /**
   * Offer a message at a step boundary. Never waits: returns undefined when
   * nothing is ready, when the quota is spent, or when the budget cannot fit.
   */
  function takeMessage(meta = {}) {
    try {
      const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined
      if (sessionId === undefined) return undefined
      const state = sessions.get(sessionId)
      if (disposed || state === undefined) return undefined
      noteTurn(state, meta.turn)
      if (state.pending.length === 0) return undefined
      if (Number.isFinite(meta.step) && state.lastInjectionStep === meta.step) {
        skip('step-quota')
        return undefined
      }
      if (state.injections >= maxInjectionsPerTurn) {
        state.pending.length = 0
        skip('turn-quota')
        return undefined
      }
      const picked = []
      while (state.pending.length > 0 && picked.length < maxCards) {
        const row = state.pending.shift()
        if (state.turnMemoryIds.has(row.id)) {
          skip('memory-seen-this-turn')
          continue
        }
        if (memoryStillVisible(meta.sessionRef, state, row.id)) {
          skip('already-in-context')
          continue
        }
        picked.push(row)
      }
      if (picked.length === 0) return undefined
      const { text, rows: rendered } = renderInjectionResult(picked, { maxBytes: maxInjectBytes, maxCards, excerptChars: 240 })
      state.pending.unshift(...picked.filter((row) => !rendered.includes(row)))
      if (text === undefined) {
        skip('budget')
        log({ kind: 'inject', phase: 'dropped', session: sessionId, reason: 'budget' })
        return undefined
      }
      const message = createPluginMessage(text)
      for (const row of rendered) {
        state.injected.set(row.id, { messageId: message.id, at: now(), turn: state.turn })
        state.turnMemoryIds.add(row.id)
      }
      state.injections += 1
      state.lastInjectionStep = meta.step
      stats.injected += 1
      stats.cards += rendered.length
      stats.bytes += Buffer.byteLength(text)
      log({
        kind: 'inject',
        session: sessionId,
        turn: meta.turn,
        step: meta.step,
        cards: rendered.map((row) => ({ id: row.id, score: row.score })),
        bytes: Buffer.byteLength(text),
        text,
      })
      return message
    } catch (error) {
      stats.failures += 1
      log({ kind: 'error', where: 'takeMessage', message: String(error?.message ?? error) })
      return undefined
    }
  }

  /**
   * Semantic fallback (SPEC 5.2, the auxiliary path): every N steps, retrieve
   * with the recent text itself as the query, so a lesson the model describes in
   * different words can still surface. It goes through the same judgement and the
   * same queue as a keyword hit — it just does not need a term to match.
   */
  function maybeSemanticFallback(meta = {}) {
    try {
      if (disposed) return
      const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined
      if (sessionId === undefined) return
      const state = stateOf(sessionId)
      noteTurn(state, meta.turn)
      if (!semanticEnabled) return
      meta = { ...meta, generation: state.generation }
      const step = Number.isFinite(meta.step) ? meta.step : undefined
      const forced = meta.force === true
      if (!forced && step !== undefined && state.lastSemanticStep !== undefined && step - state.lastSemanticStep < semanticEverySteps) return
      const context = state.recent
      if (context.replace(/\s+/g, '').length < semanticMinChars) return
      if (semanticCooldownMs > 0 && now() - (state.lastSemanticAt ?? 0) < semanticCooldownMs) {
        skip('semantic-cooldown')
        return
      }
      if (state.injections >= maxInjectionsPerTurn) {
        skip('turn-quota')
        return
      }
      if (state.recallsInFlight >= 1) {
        skip('semantic-busy')
        return
      }
      if (state.pending.length > 0) {
        skip('semantic-queued')
        return
      }
      state.lastSemanticStep = step ?? state.lastSemanticStep
      state.lastSemanticAt = now()
      stats.semantic += 1
      const label = forced ? '重复摸索兜底' : '语义兜底'
      const query = context.slice(-400).replace(/\s+/g, ' ').trim()
      if (forced) log({ kind: 'semantic-forced', reason: meta.reason ?? 'forced', session: sessionId })
      startRecall(state, label, query, meta, { kind: 'semantic' }, context)
    } catch (error) {
      stats.failures += 1
      log({ kind: 'error', where: 'maybeSemanticFallback', message: String(error?.message ?? error) })
    }
  }

  /** Reset everything for one session (new session, branch, or rewind). */
  function reset(sessionId, reason) {
    if (typeof sessionId !== 'string') return
    sessions.delete(sessionId)
    log({ kind: 'session-reset', session: sessionId, reason })
  }

  /**
   * A compaction replaced surface nodes, so queued candidates are stale and
   * previously injected memories may no longer be visible. Records are kept:
   * the surface check in takeMessage decides visibility at injection time.
   */
  function invalidate(sessionId, reason) {
    const state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (state === undefined) return
    const dropped = state.pending.length
    state.pending.length = 0
    state.generation += 1
    state.recent = ''
    log({ kind: 'invalidate', session: sessionId, reason, dropped })
  }

  function snapshot() {
    const cooling = [...termLedger.entries()].filter(([, ledger]) => ledger.rejected >= termRejectLimit && ledger.accepted === 0)
    return {
      ...stats,
      skipped: Object.fromEntries(skipped),
      sessions: sessions.size,
      pending: [...sessions.values()].reduce((total, state) => total + state.pending.length, 0),
      terms: Object.fromEntries([...sessions.entries()].map(([sessionId, state]) => [sessionId, state.turnKeywords.size])),
      cooledTerms: cooling.slice(0, 12).map(([term, ledger]) => `${term}(${ledger.rejected}/${ledger.accepted})`),
    }
  }

  function dispose() {
    disposed = true
    sessions.clear()
  }

  return { handleHits, noteToolCall, maybeSemanticFallback, takeMessage, reset, invalidate, dispose, snapshot, sessions, termLedger }
}
