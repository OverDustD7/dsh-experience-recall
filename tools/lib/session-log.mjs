// Shared helpers for reading a durable DSH session log.
//
// The log is written as one zstd frame per append, so a single
// `zstdDecompressSync` call returns only the first frame. Walk frame by frame,
// advancing by exactly the number of input bytes each engine consumed.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

export function decodeSessionLog(file) {
  const buffer = readFileSync(file)
  const parts = []
  let offset = 0
  let frames = 0
  while (offset < buffer.length) {
    const { buffer: out, engine } = zstdDecompressSync(buffer.subarray(offset), { info: true })
    parts.push(out)
    frames += 1
    const consumed = engine?.bytesWritten ?? 0
    if (consumed <= 0) break
    offset += consumed
  }
  const text = Buffer.concat(parts).toString('utf8')
  return { text, frames, bytes: Buffer.byteLength(text) }
}

/** Parse the NDJSON body, skipping unparsable lines. */
export function parseEvents(text) {
  const events = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      skipped += 1
    }
  }
  return { events, skipped }
}
