// Second-stage gate: ask the local small model whether a candidate actually
// helps the current work.
//
// Pipeline: mechanical keyword match (wide, free) -> this check (narrow, local
// GPU) -> only `useful: true` candidates may be injected.
//
// The judgement itself lives in `tools/check-relevance.mjs` so the dynamic
// Cordis runtime (which has no fetch) can call the exact same logic through a
// subprocess; here it is spawned with node's own child_process.
//
// Measured (2026-09-14, qwen3.5:9b, warm): median 292 ms, p90 305 ms; the CLI
// round trip including process start is ~370 ms; the first call after a model
// unload costs ~5 s, hence the startup warmup.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './config.js'

const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * A non-zero exit is the checker reporting "inconclusive", and its reason sits on
 * **stdout** as JSON — stderr is normally empty. Dropping it (the first version
 * only kept stderr) made the 2026-09-16 incident unreadable: every record said
 * `exit 3: ` and nothing else, while the real cause was a model load being
 * cancelled 52 times in a row. Returns the reason plus the `timedOut` flag the
 * checker sets when the local model never answered.
 */
export function diagnosticOf(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return { detail: '', timedOut: false }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { detail: text.slice(0, 160), timedOut: false }
  }
  const reason = typeof parsed?.error === 'string' ? parsed.error : ''
  const raw = typeof parsed?.raw === 'string' && parsed.raw !== '' ? ` raw=${String(parsed.raw).slice(0, 80)}` : ''
  const ms = Number.isFinite(parsed?.ms) ? ` (${parsed.ms} ms)` : ''
  const detail = `${reason}${raw}${ms}`.trim()
  return {
    detail: detail === '' ? text.slice(0, 160) : detail,
    timedOut: parsed?.timedOut === true,
  }
}

export function createVerifier(options = {}) {
  const config = options.config ?? {}
  const logger = options.logger
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const enabled = config.verifyEnabled !== false
  const checkerPath =
    typeof options.checkerPath === 'string' && options.checkerPath !== ''
      ? options.checkerPath
      : typeof config.checkerPath === 'string' && config.checkerPath !== ''
        ? config.checkerPath
        : join(PLUGIN_ROOT, 'tools', 'check-relevance.mjs')
  const nodePath = typeof config.nodePath === 'string' && config.nodePath !== '' ? config.nodePath : process.execPath
  const timeoutMs = Number.isFinite(config.verifyTimeoutMs) ? config.verifyTimeoutMs : 6000
  /**
   * Budget for the single retry after "the model never answered". Ollama cancels
   * a load when its client disconnects, so a retry inside the normal budget would
   * cancel the very load it is waiting for; this one is long enough for the load
   * to finish (measured load times: 3–11 s). Capped at 5x the normal budget so a
   * tiny test timeout stays a tiny test.
   */
  const retryTimeoutMs = Math.max(
    timeoutMs,
    Math.min(Number.isFinite(config.verifyRetryTimeoutMs) ? config.verifyRetryTimeoutMs : 30000, timeoutMs * 5),
  )
  const retryLimit = Number.isFinite(config.verifyRetryLimit) ? Math.max(0, Math.floor(config.verifyRetryLimit)) : 1
  /** Warmup patience while the model is still loading. */
  const warmupAttempts = Math.max(1, Number.isFinite(config.warmupAttempts) ? Math.floor(config.warmupAttempts) : 3)
  const warmupRetryDelayMs = Number.isFinite(config.warmupRetryDelayMs) ? Math.max(0, config.warmupRetryDelayMs) : 5000
  /** Backoff after an inconclusive judgement (the model is not answering now). */
  const backoffBaseMs = Number.isFinite(config.verifyBackoffBaseMs) ? Math.max(0, config.verifyBackoffBaseMs) : 2000
  const backoffMaxMs = Number.isFinite(config.verifyBackoffMaxMs) ? Math.max(0, config.verifyBackoffMaxMs) : 30000
  /** Floor between two judgement starts: bounds continuous local GPU load. */
  const minIntervalMs = Number.isFinite(config.verifyMinIntervalMs) ? config.verifyMinIntervalMs : 0
  const model = typeof config.localModel === 'string' ? config.localModel : ''
  const stats = {
    calls: 0,
    accepted: 0,
    rejected: 0,
    inconclusive: 0,
    unreadable: 0,
    retries: 0,
    totalMs: 0,
    waitedMs: 0,
    backoffMs: 0,
    lastError: null,
  }
  let chain = Promise.resolve()
  let lastStartAt = 0
  let inconclusiveStreak = 0
  let pauseUntil = 0

  function log(record) {
    try {
      logger?.write(record)
    } catch {
      // best effort by contract
    }
  }

  /**
   * The local model is not answering (cold load, Ollama restarting, model gone).
   * Space the next start out instead of burning one judgement per candidate:
   * base, 2x, 4x … capped. A decided verdict resets it.
   */
  function noteInconclusive() {
    inconclusiveStreak += 1
    if (backoffMaxMs <= 0) return
    const wait = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (inconclusiveStreak - 1))
    if (wait > 0) pauseUntil = Date.now() + wait
  }

  function runOnce(payload, waitMs) {
    return new Promise((resolve) => {
      let settled = false
      let child
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      let timer
      try {
        child = spawnImpl(nodePath, [checkerPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ ok: false, error: String(error?.message ?? error) })
        return
      }
      timer = setTimeout(() => {
        finish({ ok: false, error: `timeout after ${waitMs} ms`, timedOut: true })
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }, waitMs)
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on('data', (chunk) => {
        stdout = (stdout + String(chunk)).slice(0, MAX_OUTPUT_BYTES)
      })
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(0, MAX_OUTPUT_BYTES)
      })
      child.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }))
      child.on('close', (code) => {
        if (code !== 0) {
          const { detail, timedOut } = diagnosticOf(stdout)
          const seen = detail !== '' ? detail : String(stderr).trim().slice(0, 160)
          finish({ ok: false, error: `exit ${code}: ${seen}`, timedOut })
          return
        }
        finish({ ok: true, text: stdout })
      })
      // The checker reads stdin until end, so write the request and close it.
      try {
        child.stdin?.on('error', () => {
          // an early exit surfaces through the close/error handlers
        })
        child.stdin?.end(JSON.stringify(payload))
      } catch (error) {
        finish({ ok: false, error: String(error?.message ?? error) })
      }
    })
  }

  /**
   * @returns `{ useful, why, ms, inconclusive? }` — never rejects.
   * Judgements are serialized: one local model call at a time.
   */
  function verify(context, card) {
    if (!enabled) return Promise.resolve({ useful: true, why: 'verification disabled', ms: 0, skipped: true })
    const job = chain.then(async () => {
      // Waiting is the point after a failure: the local model needs time to load,
      // and re-asking it every second only cancels that load again.
      if (pauseUntil > 0) {
        const wait = pauseUntil - Date.now()
        pauseUntil = 0
        if (wait > 0) {
          stats.backoffMs += wait
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
      if (minIntervalMs > 0) {
        const wait = minIntervalMs - (Date.now() - lastStartAt)
        if (wait > 0) {
          stats.waitedMs += wait
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
      lastStartAt = Date.now()
      const started = lastStartAt
      const payload = {
        context: String(context ?? '').slice(0, Number.isFinite(config.verifyContextChars) ? config.verifyContextChars : 700),
        card: String(card ?? '').slice(0, 900),
        endpoint: config.localEndpoint ?? 'http://localhost:11434',
        ...(model === '' ? {} : { model }),
        timeoutMs: Math.max(500, timeoutMs - 500),
      }
      if (payload.context.trim() === '' || payload.card.trim() === '') {
        stats.inconclusive += 1
        return { useful: false, why: 'empty context or card', ms: 0, inconclusive: true }
      }
      let result = await runOnce(payload, timeoutMs)
      let attempts = 1
      // "The model never answered" is retried once with a budget long enough for a
      // cold load to finish. Without this, a load slower than the judgement budget
      // is cancelled by the very request that was waiting for it, and the next
      // candidate cancels it again: an unbounded livelock (DEV_NOTES 4.12).
      while (result.ok !== true && result.timedOut === true && attempts <= retryLimit) {
        attempts += 1
        stats.retries += 1
        log({ kind: 'verify', outcome: 'retry', ms: Date.now() - started, error: result.error, budgetMs: retryTimeoutMs })
        result = await runOnce({ ...payload, timeoutMs: Math.max(500, retryTimeoutMs - 500) }, retryTimeoutMs)
      }
      const ms = Date.now() - started
      stats.calls += 1
      stats.totalMs += ms
      if (!result.ok) {
        stats.inconclusive += 1
        stats.lastError = result.error
        noteInconclusive()
        log({ kind: 'verify', outcome: 'inconclusive', ms, error: result.error, attempts })
        return { useful: false, why: 'inconclusive', ms, inconclusive: true }
      }
      let parsed
      try {
        parsed = JSON.parse(String(result.text ?? '').trim())
      } catch {
        parsed = undefined
      }
      if (parsed === null || parsed === undefined || typeof parsed.useful !== 'boolean') {
        stats.inconclusive += 1
        stats.lastError = 'unparsable judgement'
        noteInconclusive()
        log({ kind: 'verify', outcome: 'inconclusive', ms, raw: String(result.text ?? '').slice(0, 160) })
        return { useful: false, why: 'unparsable', ms, inconclusive: true }
      }
      inconclusiveStreak = 0
      if (parsed.useful) stats.accepted += 1
      else stats.rejected += 1
      // `readable` is the judge reporting that it had nothing to read in the window
      // (a JSON/tool-output dump). Recorded and surfaced, never used as a gate: the
      // text heuristic for this was measured and rejected (DEV_NOTES 4.9.7).
      const readable = parsed.readable === false ? false : undefined
      if (readable === false) stats.unreadable += 1
      log({
        kind: 'verify',
        outcome: parsed.useful ? 'accepted' : 'rejected',
        ms,
        why: String(parsed.why ?? '').slice(0, 60),
        ...(readable === false ? { readable: false } : {}),
      })
      return { useful: parsed.useful, why: String(parsed.why ?? ''), ms, ...(readable === false ? { readable: false } : {}) }
    }).catch((error) => {
      stats.inconclusive += 1
      stats.lastError = String(error?.message ?? error)
      log({ kind: 'verify', outcome: 'error', error: stats.lastError })
      return { useful: false, why: stats.lastError, ms: 0, inconclusive: true }
    })
    chain = job.then(
      () => undefined,
      (error) => {
        stats.inconclusive += 1
        stats.lastError = String(error?.message ?? error)
        log({ kind: 'verify', outcome: 'error', error: stats.lastError })
      },
    )
    return job
  }

  /**
   * Load the local model before the first real judgement (cold ~5 s). Retried,
   * because a host start after an Ollama restart/upgrade can find the model gone
   * for minutes; the chain waits here, so candidates are not burned in the
   * meantime (2026-09-16 boot storm: 78 judgements spent on a load nobody let
   * finish).
   */
  function warmup() {
    if (!enabled) return Promise.resolve({ useful: false, skipped: true })
    const context = '预热：让本地判定模型驻留显存。'
    const card = '预热卡片。'
    let attempt = 0
    const once = () => {
      attempt += 1
      return verify(context, card).then((verdict) => {
        if (verdict.inconclusive !== true || attempt >= warmupAttempts) return { ...verdict, attempts: attempt }
        return new Promise((resolve) => setTimeout(resolve, warmupRetryDelayMs)).then(once)
      })
    }
    return once()
  }

  return {
    verify,
    warmup,
    enabled,
    checkerPath,
    stats: () => ({ ...stats, avgMs: stats.calls > 0 ? Math.round(stats.totalMs / stats.calls) : 0 }),
  }
}
