// Never-throwing NDJSON logger.
//
// Discipline from SPEC 5.6: nothing this plugin does may break the host. A log
// write failure is recorded in `stats().lastError` and otherwise ignored; the
// caller never sees a throw and never waits on file I/O.
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export function createLogger(options = {}) {
  const sink = typeof options.sink === 'function' ? options.sink : null
  const path = typeof options.path === 'string' && options.path !== '' ? options.path : null
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, Math.floor(options.maxBytes)) : 32 * 1024 * 1024
  let bytes = 0
  let lines = 0
  let failures = 0
  let lastError = null
  let prepared = false
  let chain = Promise.resolve()

  async function prepare() {
    if (prepared || path === null) {
      prepared = true
      return
    }
    await mkdir(dirname(path), { recursive: true })
    try {
      bytes = (await stat(path)).size
    } catch {
      bytes = 0
    }
    prepared = true
  }

  async function rotate() {
    try {
      await unlink(`${path}.1`)
    } catch {
      // no previous rotation to drop
    }
    await rename(path, `${path}.1`)
    bytes = 0
  }

  async function append(line) {
    const size = Buffer.byteLength(line)
    await prepare()
    if (maxBytes > 0 && bytes > 0 && bytes + size > maxBytes) await rotate()
    await appendFile(path, line, 'utf8')
    bytes += size
    lines += 1
  }

  function write(record) {
    try {
      const payload = record !== null && typeof record === 'object' ? record : { value: String(record) }
      const line = `${JSON.stringify({ t: new Date().toISOString(), ...payload })}\n`
      if (sink !== null) {
        sink(line.slice(0, -1))
        lines += 1
        return true
      }
      if (path === null) {
        failures += 1
        lastError = 'no log path configured'
        return false
      }
      chain = chain.then(() => append(line)).catch((error) => {
        failures += 1
        lastError = String(error?.message ?? error)
      })
      return true
    } catch (error) {
      failures += 1
      lastError = String(error?.message ?? error)
      return false
    }
  }

  return {
    write,
    flush: () => chain,
    path,
    stats: () => ({ path, bytes, lines, failures, lastError }),
  }
}
