// Unit tests for the mechanical layers: keyword matching, event text extraction,
// and the P1 observer. Run with: node --test test/
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTable, collapseWhitespace, matchKeywords, mergeTables, SEED_KEYWORDS } from '../lib/keywords.js'
import { segmentsOfEvent, toolCallKey } from '../lib/scan.js'
import { createObserver } from '../lib/observer.js'

const table = buildTable([
  { term: '统一身份认证', kind: 'intent' },
  { term: '清华 id', kind: 'intent' },
  { term: 'id.tsinghua.edu.cn', kind: 'intent' },
  { term: 'SSO', kind: 'intent' },
  { term: 'id', kind: 'probe' },
  { term: 'agent/pre-step', kind: 'action' },
])

test('Chinese terms match by substring without word boundaries', () => {
  const hits = matchKeywords('现在要做的是统一身份认证登录，然后保持登录态', table)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].term, '统一身份认证')
  assert.match(hits[0].context, /统一身份认证/)
})

test('tight view catches spacing differences inside Chinese text', () => {
  const hits = matchKeywords('清华ID登录流程', table)
  assert.ok(hits.some((hit) => hit.term === '清华 id' && hit.view === 'tight'))
})

test('Latin terms require word boundaries', () => {
  const hits = matchKeywords('the video plays while an identifier appears', table)
  assert.equal(hits.filter((hit) => hit.term === 'id').length, 0)
  const positive = matchKeywords('pass the id value', table)
  assert.equal(positive.filter((hit) => hit.term === 'id').length, 1)
})

test('Latin terms do not match longer tokens and ignore case', () => {
  assert.equal(matchKeywords('ssoxyz', table).length, 0)
  assert.equal(matchKeywords('SSO 单点登录', table).filter((hit) => hit.term === 'sso').length, 1)
  assert.equal(matchKeywords('ID.Tsinghua.EDU.CN is the entry', table).filter((hit) => hit.term === 'id.tsinghua.edu.cn').length, 1)
})

test('punctuation-bearing Latin terms keep their boundaries', () => {
  const hits = matchKeywords('edit agent/pre-step handler with { prepend: true }', table)
  assert.equal(hits.filter((hit) => hit.term === 'agent/pre-step').length, 1)
  assert.equal(matchKeywords('agent/pre-stepwise', table).filter((hit) => hit.term === 'agent/pre-step').length, 0)
})

test('normalization folds full-width characters', () => {
  assert.equal(collapseWhitespace('  ＳＳＯ \n 登录 '), 'sso 登录')
  assert.equal(matchKeywords('ＳＳＯ', table).filter((hit) => hit.term === 'sso').length, 1)
})

test('mergeTables adds memory-derived terms without dropping seeds', () => {
  const merged = mergeTables(buildTable(SEED_KEYWORDS), [{ term: '跨项目经验', kind: 'memory', memoryId: 'm1' }])
  assert.ok(merged.items.length >= SEED_KEYWORDS.length)
  const hits = matchKeywords('这条跨项目经验值得复用', merged)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].memoryId, 'm1')
})

test('assistant messages expose reasoning and body, not duplicated tool calls', () => {
  const event = {
    type: 'assistant/message',
    seq: 7,
    time: 1000,
    data: {
      turn: 1,
      step: 2,
      message: {
        role: 'assistant',
        id: 'm1',
        content: [
          { type: 'reasoning', text: '需要统一身份认证登录' },
          { type: 'text', text: '先写一个脚本' },
          { type: 'tool-call', toolCallId: 'c1', name: 'pwsh' },
        ],
      },
      stream: [{ type: 'reasoning-chunks', texts: ['ignored when content has reasoning'] }],
    },
  }
  const segments = segmentsOfEvent(event)
  assert.deepEqual(segments.map((segment) => segment.kind), ['reasoning', 'text'])
  assert.equal(segments[0].text, '需要统一身份认证登录')
})

test('reasoning falls back to stream reasoning-chunks', () => {
  const event = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '正文' }] }, stream: [{ type: 'reasoning-chunks', texts: ['思考片段一', '思考片段二'] }] },
  }
  const segments = segmentsOfEvent(event)
  assert.equal(segments[0].kind, 'text')
  assert.ok(segments.some((segment) => segment.kind === 'reasoning' && segment.fromStream === true))
})

test('tool call carries name and arguments; tool result carries text and error', () => {
  const call = { type: 'tool/call', data: { turn: 1, step: 3, callId: 'call_1', name: 'web_fetch', arguments: '{"url":"https://id.tsinghua.edu.cn"}' } }
  const callSegments = segmentsOfEvent(call)
  assert.equal(callSegments.length, 1)
  assert.match(callSegments[0].text, /id\.tsinghua\.edu\.cn/)

  const result = { type: 'tool/result', data: { turn: 1, step: 3, message: { source: { callId: 'call_1' }, content: [{ type: 'tool-result', content: 'timed out after 30000ms', isError: true }] } } }
  const resultSegments = segmentsOfEvent(result)
  assert.deepEqual(resultSegments.map((segment) => segment.kind), ['tool-result', 'error'])
  assert.match(resultSegments[1].text, /timed out/)

  const typedError = { type: 'tool/result', data: { turn: 2, step: 4, message: { source: { callId: 'call_2' }, content: [{ type: 'tool-result', content: 'boom' }] }, error: { name: 'WebError', code: 'WEB_PROVIDER_ERROR' } } }
  const typedSegments = segmentsOfEvent(typedError)
  assert.match(typedSegments.find((segment) => segment.kind === 'error').text, /WebError WEB_PROVIDER_ERROR/)
})

test('plugin-sourced user messages are marked, not treated as user input', () => {
  const event = { type: 'user/message', data: { role: 'user', id: 'u1', content: [{ type: 'text', text: '统一身份认证 注入块' }], source: { kind: 'plugin', plugin: 'dsh-experience-recall' } } }
  assert.equal(segmentsOfEvent(event)[0].kind, 'plugin-message')
  const native = { ...event, data: { ...event.data, source: { kind: 'plugin:dsh-experience-recall', form: 'recall' } } }
  assert.equal(segmentsOfEvent(native)[0].kind, 'plugin-message', 'native v4 injection is not user input')
  const user = { type: 'user/message', data: { role: 'user', id: 'u2', content: [{ type: 'text', text: '早' }], source: { kind: 'user' } } }
  assert.equal(segmentsOfEvent(user)[0].kind, 'user')
})

test('malformed events yield no segments instead of throwing', () => {
  assert.deepEqual(segmentsOfEvent(null), [])
  assert.deepEqual(segmentsOfEvent({}), [])
  assert.deepEqual(segmentsOfEvent({ type: 'assistant/message', data: null }), [])
  assert.deepEqual(segmentsOfEvent({ type: 'tool/result', data: { message: { content: 'not-an-array' } } }), [])
})

test('tool call keys include turn and step so ids reused across turns cannot collide', () => {
  assert.equal(toolCallKey({ turn: 1, step: 2, callId: 'c' }), '1:2:c')
  assert.equal(toolCallKey({ turn: 2, step: 2, message: { source: { callId: 'c' } } }), '2:2:c')
})

test('observer logs hits with context and skips its own injections', () => {
  const lines = []
  const observer = createObserver({
    logger: { write: (record) => lines.push(record), flush: () => Promise.resolve() },
    config: { statsEvery: 1000, contextChars: 20 },
  })
  observer.observe({ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '我需要清华 id 登录并保持登录态' }] } } }, { sessionId: 's1' })
  observer.observe({ type: 'user/message', seq: 2, time: 2, data: { role: 'user', content: [{ type: 'text', text: '注入：清华 id 登录' }], source: { kind: 'plugin', plugin: 'dsh-experience-recall' } } }, { sessionId: 's1' })

  const events = lines.filter((line) => line.kind === 'event')
  assert.equal(events.length, 2)
  assert.ok(events[0].hits.length >= 1)
  assert.equal(events[1].hits, undefined)
  assert.equal(observer.snapshot().hits, events[0].hits.length)
})

test('observer pairs tool calls with results and reports elapsed milliseconds', () => {
  const lines = []
  const observer = createObserver({ logger: { write: (record) => lines.push(record), flush: () => Promise.resolve() }, config: { statsEvery: 1000 } })
  observer.observe({ type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } }, { sessionId: 's1' })
  observer.observe({ type: 'tool/result', seq: 2, time: 1815, data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: 'ok' }] } } }, { sessionId: 's1' })
  const timing = lines.filter((line) => line.kind === 'timing')
  assert.equal(timing.length, 1)
  assert.equal(timing[0].toolMs, 815)
  assert.equal(timing[0].name, 'pwsh')
})

test('observer emits periodic stats and survives junk input', () => {
  const lines = []
  const observer = createObserver({ logger: { write: (record) => lines.push(record), flush: () => Promise.resolve() }, config: { statsEvery: 2 } })
  observer.observe(null)
  observer.observe(undefined, { sessionId: 's1' })
  observer.observe('not-an-event')
  observer.observe({ type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }, { sessionId: 's1' })
  observer.observe({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 2 } }, { sessionId: 's1' })
  assert.equal(observer.snapshot().failures, 0)
  assert.ok(lines.some((line) => line.kind === 'stats'))
})

test('observer logs pre-step boundaries as pass-through evidence', () => {
  const lines = []
  const observer = createObserver({ logger: { write: (record) => lines.push(record), flush: () => Promise.resolve() }, config: {} })
  observer.observePreStep({ turn: 3, step: 4, messages: [{}, {}], signal: { aborted: false } }, { sessionId: 's1' })
  const prestep = lines.find((line) => line.kind === 'prestep')
  assert.deepEqual({ turn: prestep.turn, step: prestep.step, messages: prestep.messages, aborted: prestep.aborted }, { turn: 3, step: 4, messages: 2, aborted: false })
})

test('a broken logger cannot break the observer', () => {
  const observer = createObserver({ logger: { write: () => { throw new Error('disk gone') } }, config: {} })
  assert.doesNotThrow(() => observer.observe({ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'reasoning', text: '统一身份认证' }] } } }, { sessionId: 's1' }))
})
