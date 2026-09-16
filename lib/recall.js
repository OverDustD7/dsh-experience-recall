// Tier-3 retrieval through the local mnemon CLI.
//
// Cost model (SPEC 5.2.1): the CLI talks to local SQLite + local bge-m3, so a
// recall spends local GPU time, never API tokens. Measured: ~0.4 s warm,
// ~2.8 s cold while bge-m3 loads.
//
// Rules kept here: never throw, hard timeout, bounded output, small cache, and
// at most one in-flight call per query so a hot loop cannot fork-bomb the host.
import { spawn } from 'node:child_process'

const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_CACHE_ENTRIES = 64

function extractJson(text) {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

function normalizeRows(payload) {
  const raw = Array.isArray(payload?.results) ? payload.results : []
  const rows = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : undefined
    const excerpt = typeof item.excerpt === 'string' ? item.excerpt.trim() : ''
    if (id === undefined || excerpt === '') continue
    rows.push({
      id,
      excerpt,
      category: typeof item.category === 'string' ? item.category : undefined,
      confidence: typeof item.confidence === 'string' ? item.confidence : undefined,
      score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : undefined,
      source: 'memory',
    })
  }
  return rows
}

export function createRecall(options = {}) {
  const config = options.config ?? {}
  const logger = options.logger
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const cliPath = typeof config.mnemonCliPath === 'string' ? config.mnemonCliPath : ''
  const cliArgs = Array.isArray(config.mnemonCliArgs) ? config.mnemonCliArgs : []
  const timeoutMs = Number.isFinite(config.recallTimeoutMs) ? config.recallTimeoutMs : 5000
  const cacheMs = Number.isFinite(config.recallCacheMs) ? config.recallCacheMs : 0
  const limit = Number.isFinite(config.recallLimit) ? config.recallLimit : 3
  const stats = { calls: 0, ok: 0, empty: 0, failed: 0, timedOut: 0, cacheHits: 0, totalMs: 0, lastError: null }
  const cache = new Map()
  const inflight = new Map()

  const env = {
    ...process.env,
    MNEMON_DATA_DIR: config.mnemonDataDir,
    MNEMON_STORE: config.mnemonStore,
    MNEMON_EMBED_ENDPOINT: config.mnemonEmbedEndpoint,
    MNEMON_EMBED_MODEL: config.mnemonEmbedModel,
    MNEMON_EMBED_PROTOCOL: config.mnemonEmbedProtocol,
  }

  function log(record) {
    try {
      logger?.write(record)
    } catch {
      // logging is best effort by contract
    }
  }

  function run(query, waitMs) {
    return new Promise((resolve) => {
      let settled = false
      let timedOut = false
      let child
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      let timer
      try {
        child = spawnImpl(cliPath, [...cliArgs, 'recall', query, '--limit', String(limit), '--brief'], {
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        stats.failed += 1
        stats.lastError = String(error?.message ?? error)
        resolve({ rows: [], error: stats.lastError })
        return
      }
      timer = setTimeout(() => {
        timedOut = true
        stats.timedOut += 1
        stats.lastError = `timeout after ${waitMs} ms`
        finish({ rows: [], error: stats.lastError, timedOut: true })
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
      child.on('error', (error) => {
        if (settled) return
        stats.failed += 1
        stats.lastError = String(error?.message ?? error)
        finish({ rows: [], error: stats.lastError })
      })
      child.on('close', (code) => {
        if (settled) return
        if (timedOut) {
          stats.timedOut += 1
          stats.lastError = `timeout after ${waitMs} ms`
          finish({ rows: [], error: stats.lastError, timedOut: true })
          return
        }
        if (code !== 0) {
          stats.failed += 1
          stats.lastError = `exit ${code}: ${stderr.trim().slice(0, 200)}`
          finish({ rows: [], error: stats.lastError })
          return
        }
        const rows = normalizeRows(extractJson(stdout))
        finish({ rows })
      })
    })
  }

  /**
   * Retrieve candidates for one query.
   * @returns `{ rows, error?, timedOut?, ms, cached? }` — never rejects.
   */
  async function query(text, options2 = {}) {
    const started = Date.now()
    const key = String(text ?? '').trim()
    if (key === '' || cliPath === '') {
      return { rows: [], error: cliPath === '' ? 'mnemon CLI path is not configured' : 'empty query', ms: 0 }
    }
    if (options2.cache !== false && cacheMs > 0) {
      const hit = cache.get(key)
      if (hit !== undefined && Date.now() - hit.at < cacheMs) {
        stats.cacheHits += 1
        return { rows: hit.rows, ms: 0, cached: true }
      }
    }
    const pending = inflight.get(key)
    if (pending !== undefined) return pending
    const promise = (async () => {
      stats.calls += 1
      const result = await run(key, Number.isFinite(options2.timeoutMs) ? options2.timeoutMs : timeoutMs)
      const ms = Date.now() - started
      stats.totalMs += ms
      if (result.rows.length > 0) stats.ok += 1
      else if (result.error === undefined) stats.empty += 1
      if (options2.cache !== false && cacheMs > 0 && result.rows.length > 0) {
        while (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value
          cache.delete(oldest)
        }
        cache.set(key, { at: Date.now(), rows: result.rows })
      }
      if (options2.silent !== true) {
        log({
          kind: 'recall',
          phase: 'result',
          query: key.slice(0, 120),
          ms,
          rows: result.rows.length,
          ...(result.error === undefined ? {} : { error: result.error }),
          ...(result.timedOut === true ? { timedOut: true } : {}),
        })
      }
      return { ...result, ms }
    })().finally(() => {
      inflight.delete(key)
    })
    inflight.set(key, promise)
    return promise
  }

  /** Load bge-m3 before the first real trigger so the boundary is never cold. */
  function warmup() {
    if (cliPath === '') return Promise.resolve({ rows: [], error: 'mnemon CLI path is not configured' })
    return query('预热', { cache: false, timeoutMs: Math.max(timeoutMs, 15000), silent: true })
  }

  return {
    query,
    warmup,
    cliPath,
    stats: () => ({ ...stats, cache: cache.size, inflight: inflight.size }),
  }
}
