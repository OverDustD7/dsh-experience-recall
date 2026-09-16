// Turn one session event into the plain text segments worth scanning.
//
// Event envelope (verified against real durable logs, `session.v3.jsonl`):
//   { type, seq, time, data, surfaceOp?, sourceEventSeqs? }
// Verified payload shapes:
//   user/message      data = { role, id, content: ContentBlock[], source: { kind, plugin? } }
//   assistant/message data = { turn, step, message: { role, id, source, content }, usage?, stream? }
//   tool/call         data = { turn, step, callId, name, arguments: string }
//   tool/result       data = { turn, step, message: { source: { callId }, content: [{ type, toolCallId, content, isError }] }, error?: { name, code } | null }
//   turn/end          data = { turn, reason }
//
// `message.content` in an assistant message carries `reasoning` blocks on this
// host (verified: 1410 of 1839 assistant messages in one real session), so the
// model's thinking is readable directly. `stream[].type === 'reasoning-chunks'`
// is the fallback when a provider only delivers reasoning as stream records.

const MAX_BLOCKS = 512

function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(asText).filter((part) => part !== '').join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (value.content !== undefined) return asText(value.content)
  }
  return ''
}

function contentBlocks(content) {
  return Array.isArray(content) ? content.slice(0, MAX_BLOCKS) : []
}

function streamReasoning(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream.slice(0, MAX_BLOCKS)) {
    if (record?.type !== 'reasoning-chunks') continue
    for (const text of Array.isArray(record.texts) ? record.texts : []) {
      if (typeof text === 'string' && text !== '') parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * @returns array of `{ kind, text }`; `kind` is one of
 * `user | plugin-message | reasoning | text | tool-call | tool-result | error | system`.
 */
export function segmentsOfEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : ''
  const data = event?.data
  if (data === null || typeof data !== 'object') return []
  const segments = []

  if (type === 'user/message') {
    const pluginSource = data.source !== null && typeof data.source === 'object' && data.source.kind === 'plugin'
    const text = contentBlocks(data.content).filter((block) => block?.type === 'text').map((block) => asText(block.text)).join('\n').trim()
    if (text !== '') segments.push({ kind: pluginSource ? 'plugin-message' : 'user', text })
    return segments
  }

  if (type === 'assistant/message') {
    const content = contentBlocks(data.message?.content)
    const reasoning = content.filter((block) => block?.type === 'reasoning').map((block) => asText(block.text)).join('\n').trim()
    const text = content.filter((block) => block?.type === 'text').map((block) => asText(block.text)).join('\n').trim()
    if (reasoning !== '') segments.push({ kind: 'reasoning', text: reasoning })
    if (text !== '') segments.push({ kind: 'text', text })
    if (reasoning === '') {
      const fallback = streamReasoning(data.stream).trim()
      if (fallback !== '') segments.push({ kind: 'reasoning', text: fallback, fromStream: true })
    }
    return segments
  }

  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : ''
    const args = typeof data.arguments === 'string' ? data.arguments : asText(data.arguments)
    const text = `${name} ${args}`.trim()
    if (text !== '') segments.push({ kind: 'tool-call', text })
    return segments
  }

  if (type === 'tool/result') {
    const blocks = contentBlocks(data.message?.content)
    const text = blocks.map((block) => asText(block.content ?? block.text)).filter((part) => part !== '').join('\n').trim()
    if (text !== '') segments.push({ kind: 'tool-result', text })
    const failed = blocks.filter((block) => block?.isError === true)
    const error = data.error !== null && typeof data.error === 'object' ? data.error : undefined
    const errorText = [error?.name, error?.code].filter((part) => typeof part === 'string' && part !== '').join(' ')
    if (errorText !== '' || failed.length > 0) {
      segments.push({ kind: 'error', text: `${errorText} ${failed.map((block) => asText(block.content ?? block.text)).join(' ')}`.trim() })
    }
    return segments
  }

  if (type === 'system/message') {
    const text = asText(data.content ?? data.text).trim()
    if (text !== '') segments.push({ kind: 'system', text })
    return segments
  }

  return segments
}

/**
 * Stable key for pairing a tool result with its call inside the same step.
 * Real logs reuse call ids across turns, so the key must include turn and step.
 */
export function toolCallKey(data) {
  const callId = typeof data?.callId === 'string' ? data.callId : typeof data?.message?.source?.callId === 'string' ? data.message.source.callId : ''
  return `${data?.turn ?? '?'}:${data?.step ?? '?'}:${callId}`
}

// ---------------------------------------------------------------------------
// NOT IMPLEMENTED (kept as a record, 2026-09-14): "skip the judge when the window
// is unreadable".
//
// The second-stage judge reads the last ~700 characters of real thinking. In the
// A/B sample, 5 of 45 windows were only a JSON / tool-output dump, and there every
// prompt variant drifted to `useful: true` (nothing to read → "rather give one
// more"). Skipping the judgement in that state looks strictly better than spending
// a model call on a guess.
//
// A cheap detector was attempted and REJECTED: fragments and genuine reasoning
// overlap on every signal measured over the 45 sample windows
// (machine-character density: fragments 0.058–0.122, real windows up to 0.147;
// English function-word count is *higher* in the dumps because they contain JSON).
// A threshold that caught all five fragments also suppressed real windows.
//
// Two further reasons to leave it alone:
//   * in a real session `state.recent` accumulates consecutive segments, so one
//     tool dump does not dominate; the A/B sample is a worst-case construction;
//   * the cost of a false "unreadable" is skipping a retrieval, which only shows up
//     as a missed injection and is not currently measured.
//
// Next attempt should NOT be a hand-tuned text heuristic: either measure how often
// real windows are dump-dominated (needs the card-source/observability work), or ask
// the judge itself for a third value (`"readable": false`) so the model reports the
// condition instead of a heuristic guessing it.
