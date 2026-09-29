// Tests for the second-stage relevance gate: the verifier adapter and the
// controller path that only queues what the local model calls useful.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createController } from '../lib/controller.js'
import { createVerifier } from '../lib/verify.js'

/** Minimal ChildProcess stand-in for the checker invocation. */
function fakeChild(behavior) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = (data) => {
    child.stdinData = data
    setImmediate(() => {
      const result = behavior(data)
      if (result.stdout !== undefined) child.stdout.emit('data', result.stdout)
      if (result.stderr !== undefined) child.stderr.emit('data', result.stderr)
      child.emit('close', result.code ?? 0)
    })
  }
  child.kill = () => {
    child.killed = true
    child.emit('close', 1)
  }
  return child
}

function verifierWith(behavior, config = {}) {
  const children = []
  const records = []
  const verifier = createVerifier({
    config: { verifyEnabled: true, verifyTimeoutMs: 2000, verifyContextChars: 700, ...config },
    logger: { write: (record) => records.push(record) },
    spawnImpl: (command, args) => {
      const child = fakeChild(behavior)
      children.push({ command, args, child })
      return child
    },
  })
  return { verifier, children, records }
}

test('the verifier reports a useful judgement and passes the request on stdin', async () => {
  const { verifier, children } = verifierWith(() => ({ stdout: JSON.stringify({ useful: true, why: '给出具体参数', ms: 12 }) }))
  const verdict = await verifier.verify('正在写抓取脚本', '卡片：GBK 要用 TextDecoder')
  assert.equal(verdict.useful, true)
  assert.equal(verdict.why, '给出具体参数')
  assert.equal(children.length, 1)
  const payload = JSON.parse(children[0].child.stdinData)
  assert.equal(payload.context, '正在写抓取脚本')
  assert.match(payload.card, /TextDecoder/)
  assert.ok(payload.timeoutMs <= 2000)
  assert.equal(verifier.stats().accepted, 1)
})

test('the judge can report that the window had nothing readable', async () => {
  const { verifier, records } = verifierWith(() => ({ stdout: JSON.stringify({ useful: true, readable: false, why: '窗口里只有 JSON' }) }))
  const verdict = await verifier.verify('{"content": "…", "importance": 5, "memoryBodyId": "default"}', '卡片')
  assert.equal(verdict.useful, true)
  assert.equal(verdict.readable, false, 'the reported state must reach the caller')
  assert.equal(verifier.stats().unreadable, 1)
  assert.equal(records.some((record) => record.kind === 'verify' && record.readable === false), true)
})

test('verdict logs carry the term source and the retrieved score distribution', async () => {
  const records = []
  const controller = createController({
    config: {
      minScore: 0.35,
      cooldownMs: 0,
      maxInjectionsPerTurn: 3,
      maxCardsPerInjection: 1,
      maxInjectBytes: 1200,
      verifyContextChars: 700,
      scoreLogLimit: 3,
    },
    logger: { write: (record) => records.push(record) },
    cardMeta: (term) => (term === 'doc-term' ? { termKind: 'document', source: 'document-fragment', df: 3 } : {}),
    recall: {
      query: async () => ({
        rows: [
          { id: 'a', excerpt: '卡片正文不该进日志', score: 0.9 },
          { id: 'b', excerpt: '也不该', score: 0.1 },
        ],
        ms: 1,
      }),
    },
    verify: { verify: async () => ({ useful: true, why: 'ok', ms: 1 }) },
  })
  const meta = { sessionId: 's-meta', turn: 1, sessionRef: fakeSession([]) }
  controller.handleHits([{ term: 'doc-term' }], { ...meta, step: 1, text: '正在给网络学堂写保持登录态的脚本' })
  await tick()

  const scores = records.find((record) => record.kind === 'recall' && record.phase === 'scores')
  assert.ok(scores !== undefined, 'the score distribution must be recorded')
  assert.deepEqual(scores.scores, [0.9, 0.1], 'scores of every retrieved row, not just the survivors')
  assert.equal(scores.above, 1, 'only one row clears minScore')
  assert.equal(JSON.stringify(scores).includes('卡片正文'), false, 'numbers only, never card content')

  const queued = records.find((record) => record.kind === 'recall' && record.phase === 'queued')
  assert.ok(queued !== undefined)
  assert.equal(queued.termKind, 'document', 'the verdict must say which half of the vocabulary fired')
  assert.equal(queued.source, 'document-fragment')
  assert.equal(queued.df, 3)
  assert.equal(controller.snapshot().bySource['document/document-fragment'], 1)
})

test('a rejection, an unparsable answer and a failed process are all contained', async () => {
  const rejected = verifierWith(() => ({ stdout: JSON.stringify({ useful: false, why: '话题相近但用不上' }) }))
  assert.equal((await rejected.verifier.verify('ctx', 'card')).useful, false)
  assert.equal(rejected.verifier.stats().rejected, 1)

  const garbage = verifierWith(() => ({ stdout: 'not json' }))
  const garbageVerdict = await garbage.verifier.verify('ctx', 'card')
  assert.equal(garbageVerdict.useful, false)
  assert.equal(garbageVerdict.inconclusive, true)
  assert.equal(garbage.verifier.stats().inconclusive, 1)

  const broken = verifierWith(() => ({ stderr: 'boom', code: 3 }))
  const brokenVerdict = await broken.verifier.verify('ctx', 'card')
  assert.equal(brokenVerdict.inconclusive, true)
  assert.match(String(broken.verifier.stats().lastError), /exit 3/)
})

test('the checker reason survives a non-zero exit: it is on stdout, not stderr', async () => {
  // Regression (2026-09-16): the exit path only kept stderr, so every record read
  // `exit 3: ` and the actual cause (a cancelled model load) was invisible.
  const { verifier, records } = verifierWith(() => ({ stdout: JSON.stringify({ error: 'fetch failed', ms: 88 }), code: 3 }))
  const verdict = await verifier.verify('ctx', 'card')
  assert.equal(verdict.inconclusive, true)
  assert.match(String(verifier.stats().lastError), /exit 3: fetch failed/)
  assert.ok(records.some((record) => record.kind === 'verify' && /fetch failed/.test(String(record.error))))
})

test('a judgement the model never answered is retried once with a longer budget', async () => {
  // Aborting a cold load cancels it, so retrying inside the same budget cancels the
  // load again and again (52 aborted loads in a row on 2026-09-16).
  let calls = 0
  const { verifier, children } = verifierWith(
    () => {
      calls += 1
      if (calls === 1) {
        return { stdout: JSON.stringify({ error: 'The operation was aborted', timedOut: true, ms: 5500 }), code: 3 }
      }
      return { stdout: JSON.stringify({ useful: true, why: 'ok', ms: 900 }) }
    },
    { verifyTimeoutMs: 6000, verifyRetryTimeoutMs: 30000, verifyRetryLimit: 1, verifyBackoffBaseMs: 0 },
  )
  const verdict = await verifier.verify('ctx', 'card')
  assert.equal(verdict.useful, true)
  assert.equal(children.length, 2, 'exactly one longer retry')
  assert.equal(JSON.parse(children[1].child.stdinData).timeoutMs, 29500, 'the retry carries the longer budget')
  assert.equal(verifier.stats().retries, 1)
  assert.equal(verifier.stats().inconclusive, 0, 'the retry that answered is not an inconclusive judgement')
})

test('a failure that is not a timeout is not retried, and it spaces the next start out', async () => {
  const { verifier, children } = verifierWith(
    () => ({ stdout: JSON.stringify({ error: 'fetch failed', ms: 88 }), code: 3 }),
    { verifyBackoffBaseMs: 40, verifyBackoffMaxMs: 40 },
  )
  await verifier.verify('ctx', 'card')
  await verifier.verify('ctx', 'card')
  assert.equal(children.length, 2, 'a connection error must not cost a second call')
  assert.ok(verifier.stats().backoffMs > 0, 'the next judgement waits instead of hammering a model that is still loading')
  assert.equal(verifier.stats().inconclusive, 2)
})

test('warmup keeps trying while the model is loading, and gives up at the limit', async () => {
  let calls = 0
  const slowStart = verifierWith(
    () => {
      calls += 1
      if (calls <= 2) return { stdout: JSON.stringify({ error: 'fetch failed', ms: 50 }), code: 3 }
      return { stdout: JSON.stringify({ useful: false, why: '预热卡片本来就没用' }) }
    },
    { warmupAttempts: 3, warmupRetryDelayMs: 5, verifyBackoffBaseMs: 0 },
  )
  const warmed = await slowStart.verifier.warmup()
  assert.equal(calls, 3, 'two unanswered attempts, then a real answer')
  assert.equal(warmed.attempts, 3)
  assert.equal(warmed.inconclusive, undefined, 'a decided verdict ends the warmup')

  let attempts = 0
  const never = verifierWith(
    () => {
      attempts += 1
      return { stdout: JSON.stringify({ error: 'fetch failed', ms: 50 }), code: 3 }
    },
    { warmupAttempts: 2, warmupRetryDelayMs: 5, verifyBackoffBaseMs: 0 },
  )
  const failed = await never.verifier.warmup()
  assert.equal(attempts, 2, 'bounded: it must not retry forever')
  assert.equal(failed.inconclusive, true)
  assert.equal(failed.attempts, 2)
})

test('judgements are serialized: two calls never run at the same time', async () => {
  let concurrent = 0
  let peak = 0
  const { verifier } = verifierWith(() => {
    concurrent += 1
    peak = Math.max(peak, concurrent)
    setImmediate(() => {
      concurrent -= 1
    })
    return { stdout: JSON.stringify({ useful: true, why: 'ok' }) }
  })
  await Promise.all([verifier.verify('a', 'x'), verifier.verify('b', 'y'), verifier.verify('c', 'z')])
  assert.equal(peak, 1, 'the local model must never be called concurrently')
  assert.equal(verifier.stats().calls, 3)
})

test('a disabled verifier accepts everything without spawning anything', async () => {
  const { verifier, children } = verifierWith(() => ({ stdout: '{}' }), { verifyEnabled: false })
  const verdict = await verifier.verify('ctx', 'card')
  assert.equal(verdict.useful, true)
  assert.equal(verdict.skipped, true)
  assert.equal(children.length, 0)
})

// ------------------------------------------------------- controller wiring ---

const MEM = { id: 'mem-1', excerpt: '经验卡片正文', score: 0.6 }

function controllerWith(verdict, config = {}) {
  const records = []
  const controller = createController({
    config: { minScore: 0, cooldownMs: 0, maxInjectionsPerTurn: 3, maxCardsPerInjection: 2, maxInjectBytes: 1200, verifyContextChars: 700, ...config },
    logger: { write: (record) => records.push(record) },
    recall: { query: async () => ({ rows: [MEM], ms: 1 }) },
    verify: { verify: async () => verdict },
  })
  return { controller, records }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('the longest matching term wins the candidate slot', async () => {
  // Regression: scan order once let `pwsh` (a term every memory carries) beat
  // `统一身份认证`, so the useful memory was never retrieved.
  const queries = []
  const controller = createController({
    config: { minScore: 0, cooldownMs: 0, maxInjectionsPerTurn: 3, maxCardsPerInjection: 2, maxInjectBytes: 1200, verifyContextChars: 700 },
    logger: { write: () => {} },
    recall: {
      query: async (query) => {
        queries.push(query)
        return { rows: [], ms: 1 }
      },
    },
    verify: { verify: async () => ({ useful: true, why: 'ok', ms: 1 }) },
  })
  controller.handleHits(
    [
      { term: 'pwsh', memoryId: 'mem-pwsh', excerpt: '关于 pwsh 的记忆' },
      { term: '统一身份认证', context: '要给校内网站写登录' },
    ],
    { sessionId: 's5', turn: 1, step: 1, text: '正在写清华统一身份认证的登录脚本' },
  )
  await tick()
  assert.equal(queries.length, 1)
  assert.match(queries[0], /统一身份认证/, 'the more specific term must drive the retrieval')
})

test('only a candidate the judge calls useful reaches the injection queue', async () => {
  const accepted = controllerWith({ useful: true, why: 'ok', ms: 5 })
  accepted.controller.handleHits([{ term: 'zhjwxk', memoryId: MEM.id, excerpt: MEM.excerpt, context: 'x' }], { sessionId: 's1', turn: 1, step: 1, text: '正在抓教务数据' })
  await tick()
  assert.equal(accepted.controller.snapshot().accepted, 1)
  assert.ok(accepted.controller.takeMessage({ sessionId: 's1', turn: 1, step: 2, sessionRef: fakeSession([]) }) !== undefined)

  const rejected = controllerWith({ useful: false, why: '无关', ms: 5 })
  rejected.controller.handleHits([{ term: 'zhjwxk', memoryId: MEM.id, excerpt: MEM.excerpt, context: 'x' }], { sessionId: 's2', turn: 1, step: 1, text: '在做 Excel' })
  await tick()
  assert.equal(rejected.controller.snapshot().rejected, 1)
  assert.equal(rejected.controller.takeMessage({ sessionId: 's2', turn: 1, step: 2, sessionRef: fakeSession([]) }), undefined)
  assert.ok(rejected.records.some((record) => record.kind === 'recall' && record.phase === 'rejected'))
})

test('an unanswered judgement is counted apart from a rejection, in stats and in the log', async () => {
  // "The judge could not answer" is not "the judge said no": counting it as a
  // rejection corrupts the acceptance rate and the per-source table.
  const { controller, records } = controllerWith({ useful: false, why: 'inconclusive', inconclusive: true, ms: 5500 })
  controller.handleHits([{ term: 'zhjwxk', memoryId: MEM.id, excerpt: MEM.excerpt, context: 'x' }], { sessionId: 's7', turn: 1, step: 1, text: '正在抓教务数据' })
  await tick()
  const snapshot = controller.snapshot()
  assert.equal(snapshot.inconclusive, 1)
  assert.equal(snapshot.rejected, 0, 'an unanswered judgement is not a rejection')
  assert.equal(snapshot.termCooldowns, 0, 'and it must not damage the term reputation')
  const record = records.find((entry) => entry.kind === 'recall' && entry.phase === 'rejected')
  assert.equal(record.inconclusive, true, 'the record carries the flag the report splits on')
})

test('a recall result is judged too, and the recent session text becomes the context', async () => {
  const seen = []
  const controller = createController({
    config: { minScore: 0, cooldownMs: 0, maxInjectionsPerTurn: 3, maxCardsPerInjection: 2, maxInjectBytes: 1200, verifyContextChars: 700 },
    logger: { write: () => {} },
    recall: { query: async () => ({ rows: [MEM], ms: 1 }) },
    verify: {
      verify: async (context, card) => {
        seen.push({ context, card })
        return { useful: true, why: 'ok', ms: 1 }
      },
    },
  })
  controller.handleHits([{ term: '统一身份认证', context: '窗口' }], { sessionId: 's3', turn: 1, step: 1, text: '要给网络学堂写登录脚本' })
  await tick()
  assert.equal(seen.length, 1)
  assert.match(seen[0].context, /网络学堂/)
  assert.equal(seen[0].card, MEM.excerpt)
})

test('the semantic fallback fires on its own cadence and only with enough recent text', async () => {
  const queries = []
  const controller = createController({
    config: {
      minScore: 0,
      cooldownMs: 0,
      maxInjectionsPerTurn: 3,
      maxCardsPerInjection: 1,
      maxInjectBytes: 1200,
      verifyContextChars: 700,
      semanticEverySteps: 3,
      semanticMinChars: 20,
      semanticCooldownMs: 0,
    },
    logger: { write: () => {} },
    recall: {
      query: async (query) => {
        queries.push(query)
        return { rows: [], ms: 1 }
      },
    },
    verify: { verify: async () => ({ useful: true, why: 'ok', ms: 1 }) },
  })
  const meta = { sessionId: 's9', turn: 1, sessionRef: fakeSession([]) }
  // Too little recent text: the fallback stays quiet.
  controller.maybeSemanticFallback({ ...meta, step: 1 })
  await tick()
  assert.equal(controller.snapshot().semantic, 0)

  // The controller learns the session's recent text from the scanned events.
  controller.handleHits([{ term: '统一身份认证' }], {
    ...meta,
    step: 1,
    text: '正在给清华统一身份认证写保持登录态的脚本，讨论 cookie 与 session 的保活细节',
  })
  await tick()
  controller.maybeSemanticFallback({ ...meta, step: 2 })
  await tick()
  assert.equal(controller.snapshot().semantic, 1, 'the first boundary may use the fallback')
  assert.ok(queries.some((query) => /统一身份认证/.test(query)), 'the recent text itself is the query')

  controller.maybeSemanticFallback({ ...meta, step: 3 })
  await tick()
  assert.equal(controller.snapshot().semantic, 1, 'not again before N steps have passed')

  controller.maybeSemanticFallback({ ...meta, step: 5 })
  await tick()
  assert.equal(controller.snapshot().semantic, 2, 'N steps later it fires again')
})

test('a term the judge keeps rejecting earns a cooldown instead of costing a call every event', async () => {
  let calls = 0
  const controller = createController({
    config: {
      minScore: 0,
      cooldownMs: 0,
      maxInjectionsPerTurn: 5,
      maxCardsPerInjection: 1,
      maxInjectBytes: 1200,
      verifyContextChars: 300,
      termRejectLimit: 2,
      termBlockCooldownMs: 60000,
      semanticFallback: false,
    },
    logger: { write: () => {} },
    recall: { query: async () => ({ rows: [MEM], ms: 1 }) },
    verify: {
      verify: async () => {
        calls += 1
        return { useful: false, why: 'noise', ms: 1 }
      },
    },
  })
  const text = '一段足够长的当前工作上下文，用来让判定器有话可说。'
  controller.handleHits([{ term: 'noisy' }], { sessionId: 's10', turn: 1, step: 1, text })
  await tick()
  controller.handleHits([{ term: 'noisy' }], { sessionId: 's10', turn: 2, step: 1, text })
  await tick()
  assert.equal(calls, 2)
  controller.handleHits([{ term: 'noisy' }], { sessionId: 's10', turn: 3, step: 1, text })
  await tick()
  assert.equal(calls, 2, 'after the reject limit the term must not cost another model call')
  assert.ok(controller.snapshot().skipped['term-cooldown'] >= 1)
  assert.equal(controller.snapshot().termCooldowns, 1)
  assert.ok(controller.snapshot().cooledTerms.some((entry) => entry.startsWith('noisy')))
})

test('an injection that drifted far behind the tail counts as forgotten', async () => {
  let distance = 100
  const controller = createController({
    config: {
      minScore: 0,
      cooldownMs: 0,
      maxInjectionsPerTurn: 3,
      maxCardsPerInjection: 1,
      maxInjectBytes: 1200,
      verifyContextChars: 300,
      reinjectTokenDistance: 1000,
      semanticFallback: false,
    },
    logger: { write: () => {} },
    recall: { query: async () => ({ rows: [MEM], ms: 1 }) },
    verify: { verify: async () => ({ useful: true, why: 'ok', ms: 1 }) },
    surfaceDistance: () => distance,
  })
  const text = '要写一个抓取脚本，正在看凭据与登录态的处理方式。'
  const hit = { term: 'zhjwxk', memoryId: MEM.id, excerpt: MEM.excerpt, context: 'x' }
  controller.handleHits([hit], { sessionId: 's11', turn: 1, step: 1, text })
  await tick()
  const first = controller.takeMessage({ sessionId: 's11', turn: 1, step: 2, sessionRef: fakeSession([]) })
  assert.ok(first !== undefined)
  const live = fakeSession([pluginMessageEvent(5, first.id)])

  controller.handleHits([hit], { sessionId: 's11', turn: 2, step: 1, sessionRef: live, text })
  await tick()
  assert.equal(controller.takeMessage({ sessionId: 's11', turn: 2, step: 2, sessionRef: live }), undefined, 'still near the tail: do not repeat')

  distance = 50000
  controller.handleHits([hit], { sessionId: 's11', turn: 3, step: 1, sessionRef: live, text })
  await tick()
  assert.ok(controller.takeMessage({ sessionId: 's11', turn: 3, step: 2, sessionRef: live }) !== undefined, 'far behind the tail: inject again')
  assert.ok(controller.snapshot().reinjectFar >= 1)
})

test('the same tool call repeated in a short window triggers a retrieval', async () => {
  const queries = []
  const controller = createController({
    config: {
      minScore: 0,
      cooldownMs: 0,
      maxInjectionsPerTurn: 3,
      maxCardsPerInjection: 1,
      maxInjectBytes: 1200,
      verifyContextChars: 300,
      semanticEverySteps: 99,
      semanticMinChars: 20,
      semanticCooldownMs: 0,
      repeatToolLimit: 3,
      repeatWindowSteps: 12,
    },
    logger: { write: () => {} },
    recall: {
      query: async (query) => {
        queries.push(query)
        return { rows: [], ms: 1 }
      },
    },
    verify: { verify: async () => ({ useful: true, why: 'ok', ms: 1 }) },
  })
  const text = '同一个报错反复出现，我已经试了两次同样的命令，似乎卡住了。'
  controller.handleHits([{ term: '统一身份认证' }], { sessionId: 's12', turn: 1, step: 1, text })
  await tick()
  const before = controller.snapshot().semantic
  const call = { sessionId: 's12', name: 'pwsh', arguments: '{"command":"npm test"}', turn: 1 }
  controller.noteToolCall({ ...call, step: 2 })
  controller.noteToolCall({ ...call, step: 3 })
  controller.noteToolCall({ ...call, step: 4 })
  await tick()
  assert.equal(controller.snapshot().repeatTriggers, 1)
  assert.equal(controller.snapshot().semantic, before + 1)
  assert.ok(queries.some((query) => /报错/.test(query)), 'the recent text carries the stuck context')
})

function pluginMessageEvent(seq, id) {
  return {
    seq,
    type: 'user/message',
    data: { id, role: 'user', source: { kind: 'plugin:dsh-experience-recall' }, content: [] },
  }
}

function fakeSession(entries) {
  const nodes = entries.map((entry) => entry.seq)
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]))
  return { surface: { nodes }, eventAt: (seq) => bySeq.get(seq) }
}
