// Stage P2 tests: the retrieval adapter, the injection renderer, the surface
// visibility check, the gates, and the boundary injection path end to end.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.js'
import { createController } from '../lib/controller.js'
import { createRecall } from '../lib/recall.js'
import { cleanExcerpt, renderInjection, shortId } from '../lib/render.js'
import { messageVisibleInSurface } from '../lib/surface.js'
import { PLUGIN_NAME } from '../lib/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeCli = join(here, '..', 'tools', 'fixtures', 'fake-mnemon.mjs')

function quietLogger(records = []) {
  return { write: (record) => records.push(record), flush: () => Promise.resolve() }
}

function fakeRecall(rows) {
  return { query: async () => ({ rows, ms: 3 }) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

// ---------------------------------------------------------------- recall ---

function cliRecall(extra = {}) {
  return createRecall({
    config: {
      mnemonCliPath: process.execPath,
      mnemonCliArgs: [fakeCli],
      recallTimeoutMs: 2000,
      recallLimit: 3,
      recallCacheMs: 0,
      mnemonDataDir: 'C:/tmp/mnemon',
      mnemonStore: 'default',
      mnemonEmbedEndpoint: 'http://localhost:11434',
      mnemonEmbedModel: 'bge-m3',
      mnemonEmbedProtocol: 'ollama',
      ...extra,
    },
    logger: quietLogger(),
  })
}

test('recall parses CLI output past leading noise and normalizes rows', async () => {
  const recall = cliRecall()
  const result = await recall.query('清华统一身份认证 登录态')
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].id, '11111111-2222-3333-4444-555555555555')
  assert.match(result.rows[0].excerpt, /经验/)
  assert.equal(result.rows[0].score, 0.52)
  assert.equal(recall.stats().ok, 1)
})

test('recall returns nothing instead of throwing when the CLI fails or is missing', async () => {
  process.env.FAKE_MNEMON_MODE = 'fail'
  try {
    const failed = await cliRecall().query('任意查询')
    assert.deepEqual(failed.rows, [])
    assert.match(String(failed.error), /exit 2/)
  } finally {
    delete process.env.FAKE_MNEMON_MODE
  }

  const missing = createRecall({ config: { mnemonCliPath: '' }, logger: quietLogger() })
  const result = await missing.query('任意查询')
  assert.deepEqual(result.rows, [])
  assert.match(String(result.error), /not configured/)

  const empty = await missing.query('')
  assert.deepEqual(empty.rows, [])
})

test('recall enforces its timeout and reports it', async () => {
  process.env.FAKE_MNEMON_MODE = 'slow'
  try {
    const recall = cliRecall({ recallTimeoutMs: 150 })
    const started = Date.now()
    const result = await recall.query('慢查询')
    assert.deepEqual(result.rows, [])
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 3000, 'the timeout must cut the child loose')
    assert.equal(recall.stats().timedOut, 1)
  } finally {
    delete process.env.FAKE_MNEMON_MODE
  }
})

test('recall caches identical queries and reports empty results', async () => {
  const recall = cliRecall({ recallCacheMs: 60000 })
  const first = await recall.query('缓存查询')
  const second = await recall.query('缓存查询')
  assert.equal(first.rows.length, 2)
  assert.equal(second.cached, true)
  assert.equal(recall.stats().calls, 1)
  assert.equal(recall.stats().cacheHits, 1)

  process.env.FAKE_MNEMON_MODE = 'empty'
  try {
    const empty = await cliRecall().query('没有结果')
    assert.deepEqual(empty.rows, [])
    assert.equal(empty.error, undefined)
  } finally {
    delete process.env.FAKE_MNEMON_MODE
  }
})

// ---------------------------------------------------------------- render ---

test('renderer caps total bytes, cleans excerpts, and shortens ids', () => {
  const text = renderInjection([{ id: '11111111-2222-3333-4444-555555555555', excerpt: '**要点**：`code` 与\n换行' }], { maxBytes: 1200, maxCards: 2 })
  assert.ok(text.startsWith('【可能相关的历史经验'))
  assert.match(text, /记忆 id: 11111111/)
  assert.ok(!text.includes('**') && !text.includes('`'))
  assert.ok(Buffer.byteLength(text) <= 1200)
  assert.equal(shortId('11111111-2222'), '11111111')

  const huge = `<b>${'字'.repeat(5000)}</b>`
  const capped = renderInjection([{ id: 'x', excerpt: huge }], { maxBytes: 400, maxCards: 2 })
  assert.ok(capped === undefined || Buffer.byteLength(capped) <= 400)

  assert.equal(renderInjection([], { maxBytes: 400 }), undefined)
  assert.equal(cleanExcerpt('a\n\nb', 10), 'a b')
})

// --------------------------------------------------------------- surface ---

function fakeSession(entries) {
  const nodes = entries.map((entry) => entry.seq)
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]))
  return { surface: { nodes }, eventAt: (seq) => bySeq.get(seq) }
}

function pluginMessageEvent(seq, id) {
  return { seq, type: 'user/message', data: { id, role: 'user', source: { kind: 'plugin', plugin: PLUGIN_NAME }, content: [] } }
}

test('surface check finds a live injection and ignores foreign or missing ones', () => {
  const session = fakeSession([
    { seq: 1, type: 'user/message', data: { id: 'u1', source: { kind: 'user' } } },
    pluginMessageEvent(2, 'ours-live'),
  ])
  assert.equal(messageVisibleInSurface(session, (id) => id === 'ours-live'), true)
  assert.equal(messageVisibleInSurface(session, (id) => id === 'other'), false)
  assert.equal(messageVisibleInSurface({ surface: { nodes: [2] } }, () => true), false, 'unknown surface is not visible')
  assert.equal(messageVisibleInSurface(undefined, () => true), false)
})

// ------------------------------------------------------------ controller ---

const MEM_A = { id: 'aaaaaaaa-1111-2222-3333-444444444444', excerpt: '经验 A 的要点', score: 0.6 }
const MEM_B = { id: 'bbbbbbbb-1111-2222-3333-444444444444', excerpt: '经验 B 的要点', score: 0.55 }

function controllerWith(rows, config = {}) {
  const records = []
  const controller = createController({
    config: {
      minScore: 0.35,
      cooldownMs: 60000,
      maxInjectionsPerTurn: 3,
      maxCardsPerInjection: 2,
      maxInjectBytes: 1200,
      recallTimeoutMs: 1000,
      ...config,
    },
    logger: quietLogger(records),
    recall: fakeRecall(rows),
  })
  return { controller, records }
}

test('same keyword triggers only once per turn and the queue drains at a boundary', async () => {
  const { controller, records } = controllerWith([MEM_A])
  const meta = { sessionId: 's1', turn: 1, step: 1 }
  controller.handleHits([{ term: '统一身份认证', kind: 'intent', context: '需要统一身份认证登录' }], meta)
  controller.handleHits([{ term: '统一身份认证', kind: 'intent', context: 'again' }], meta)
  await tick()
  assert.equal(controller.snapshot().recalls, 1, 'the second hit in the same turn must not fire a recall')

  const message = controller.takeMessage({ ...meta, step: 2, sessionRef: fakeSession([]) })
  assert.ok(message !== undefined)
  assert.equal(message.role, 'user')
  assert.equal(message.source.plugin, PLUGIN_NAME)
  assert.match(message.content[0].text, /经验 A 的要点/)
  assert.equal(controller.takeMessage({ ...meta, step: 3, sessionRef: fakeSession([]) }), undefined, 'one injection per boundary')
  assert.ok(records.some((record) => record.kind === 'inject' && record.cards.length === 1))
})

test('a new turn re-arms the keyword, and the cooldown still guards repeats', async () => {
  const fresh = controllerWith([MEM_A], { cooldownMs: 0 })
  fresh.controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's1', turn: 1, step: 1 })
  await tick()
  fresh.controller.takeMessage({ sessionId: 's1', turn: 1, step: 2, sessionRef: fakeSession([]) })
  fresh.controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's1', turn: 1, step: 3 })
  await tick()
  assert.equal(fresh.controller.snapshot().skipped['keyword-seen-this-turn'], 1)
  fresh.controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's1', turn: 2, step: 1 })
  await tick()
  assert.equal(fresh.controller.snapshot().recalls, 2, 'a new turn may trigger again')

  const cooled = controllerWith([MEM_A], { cooldownMs: 60000 })
  cooled.controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's2', turn: 1, step: 1 })
  await tick()
  cooled.controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's2', turn: 2, step: 1 })
  await tick()
  assert.equal(cooled.controller.snapshot().recalls, 1, 'the cooldown spans turns')
  assert.equal(cooled.controller.snapshot().skipped.cooldown, 1)
})

test('candidates below minScore are dropped and the same memory is not queued twice', async () => {
  const low = controllerWith([{ id: 'low', excerpt: '低分', score: 0.1 }])
  low.controller.handleHits([{ term: '网络学堂', kind: 'intent' }], { sessionId: 's2', turn: 1, step: 1 })
  await tick()
  assert.equal(low.controller.snapshot().skipped['below-min-score'], 1)
  assert.equal(low.controller.takeMessage({ sessionId: 's2', turn: 1, step: 2 }), undefined)

  const dup = controllerWith([MEM_A], { cooldownMs: 0 })
  dup.controller.handleHits([{ term: '网络学堂', kind: 'intent' }], { sessionId: 's3', turn: 1, step: 1 })
  await tick()
  dup.controller.takeMessage({ sessionId: 's3', turn: 1, step: 2, sessionRef: fakeSession([]) })
  dup.controller.handleHits([{ term: '登录态', kind: 'intent' }], { sessionId: 's3', turn: 1, step: 3 })
  await tick()
  assert.equal(dup.controller.snapshot().skipped['memory-seen-this-turn'], 1)
})

test('an injection still visible in the surface is not repeated; once gone it may come back', async () => {
  const { controller } = controllerWith([MEM_A], { cooldownMs: 0 })
  controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's4', turn: 1, step: 1 })
  await tick()
  const first = controller.takeMessage({ sessionId: 's4', turn: 1, step: 2, sessionRef: fakeSession([]) })
  assert.ok(first !== undefined)

  const live = fakeSession([pluginMessageEvent(5, first.id)])
  controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's4', turn: 2, step: 1, sessionRef: live })
  await tick()
  assert.equal(controller.takeMessage({ sessionId: 's4', turn: 2, step: 2, sessionRef: live }), undefined)
  assert.equal(controller.snapshot().skipped['already-in-context'], 1)

  // A rewind or compaction replaced the surface, so the memory may return.
  const empty = fakeSession([])
  controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's4', turn: 3, step: 1, sessionRef: empty })
  await tick()
  assert.ok(controller.takeMessage({ sessionId: 's4', turn: 3, step: 2, sessionRef: empty }) !== undefined)
})

test('per-turn quota stops injection even when a recall is queued', async () => {
  const { controller } = controllerWith([MEM_A, MEM_B], { maxInjectionsPerTurn: 1 })
  controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's5', turn: 1, step: 1 })
  await tick()
  assert.ok(controller.takeMessage({ sessionId: 's5', turn: 1, step: 2, sessionRef: fakeSession([]) }) !== undefined)
  controller.handleHits([{ term: '登录态', kind: 'intent' }], { sessionId: 's5', turn: 1, step: 3 })
  await tick()
  assert.equal(controller.takeMessage({ sessionId: 's5', turn: 1, step: 4, sessionRef: fakeSession([]) }), undefined)
  assert.ok(controller.snapshot().skipped['turn-quota'] >= 1)
})

test('cooldown and in-flight guards keep a hot loop from spawning recall storms', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const controller = createController({
    config: { minScore: 0, cooldownMs: 60000, maxInjectionsPerTurn: 5, maxCardsPerInjection: 2, maxInjectBytes: 1200 },
    logger: quietLogger(),
    recall: { query: () => gate },
  })
  controller.handleHits([{ term: 'A' }], { sessionId: 's6', turn: 1, step: 1 })
  assert.equal(controller.snapshot().recalls, 1)
  // One candidate per event, and a second event while the first recall is still
  // in flight is skipped instead of stacking another process.
  controller.handleHits([{ term: 'B' }], { sessionId: 's6', turn: 1, step: 2 })
  assert.equal(controller.snapshot().recalls, 1)
  assert.equal(controller.snapshot().skipped.busy, 1)
  release({ rows: [MEM_A] })
  await tick()
  // The pipeline holds one candidate at a time, so drain the queue before the
  // next trigger can start a recall.
  assert.ok(controller.takeMessage({ sessionId: 's6', turn: 1, step: 3, sessionRef: fakeSession([]) }) !== undefined)
  controller.handleHits([{ term: 'A' }], { sessionId: 's6', turn: 1, step: 2 })
  assert.equal(controller.snapshot().recalls, 1, 'the cooldown still applies inside the same turn')
  controller.handleHits([{ term: 'C' }], { sessionId: 's6', turn: 2, step: 1 })
  assert.equal(controller.snapshot().recalls, 2)
})

test('reset and invalidate drop stale session state', async () => {
  const { controller, records } = controllerWith([MEM_A])
  controller.handleHits([{ term: '统一身份认证', kind: 'intent' }], { sessionId: 's7', turn: 1, step: 1 })
  await tick()
  controller.invalidate('s7', 'compaction/summary')
  assert.equal(controller.takeMessage({ sessionId: 's7', turn: 1, step: 2, sessionRef: fakeSession([]) }), undefined)
  controller.reset('s7', 'session-start')
  assert.equal(controller.sessions.size, 0)
  assert.ok(records.some((record) => record.kind === 'invalidate'))
  assert.ok(records.some((record) => record.kind === 'session-reset'))
})

test('a retrieval failure is contained and never throws out of the controller', async () => {
  const records = []
  const controller = createController({
    config: { minScore: 0, cooldownMs: 0, maxInjectionsPerTurn: 3, maxCardsPerInjection: 2, maxInjectBytes: 1200 },
    logger: quietLogger(records),
    recall: {
      query: async () => {
        throw new Error('cli exploded')
      },
    },
  })
  controller.handleHits([{ term: '统一身份认证' }], { sessionId: 's8', turn: 1, step: 1 })
  await tick()
  assert.equal(controller.takeMessage({ sessionId: 's8', turn: 1, step: 2 }), undefined)
  assert.equal(controller.snapshot().failures, 1)
  assert.ok(records.some((record) => record.kind === 'error' && /cli exploded/.test(record.message)))
})

// ------------------------------------------------- end-to-end through apply ---

function createMockCtx() {
  const rootHandlers = new Map()
  const effects = []
  return {
    rootHandlers,
    effects,
    ctx: {
      on(event, handler) {
        rootHandlers.set(event, handler)
        return () => rootHandlers.delete(event)
      },
      get() {
        return undefined
      },
      effect(callback) {
        const dispose = callback()
        effects.push(dispose)
        return dispose
      },
    },
  }
}

function createMockAgent(id, sessionId) {
  const scopedHandlers = new Map()
  return {
    scopedHandlers,
    agent: {
      id,
      session: { id: sessionId },
      ctx: {
        on(event, handler) {
          scopedHandlers.set(event, handler)
          return () => scopedHandlers.delete(event)
        },
      },
    },
  }
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

test('apply wires observer -> CLI recall -> boundary injection end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-p2-'))
  const logPath = join(dir, 'observe.ndjson')
  try {
    const mock = createMockCtx()
    const dispose = apply(mock.ctx, {
      logPath,
      statsEvery: 1000,
      mnemonCliPath: process.execPath,
      mnemonCliArgs: [fakeCli],
      warmupOnStart: false,
      cooldownMs: 0,
      recallTimeoutMs: 3000,
      minScore: 0.35,
      // Keep the live vocabulary and the local judgement out of this test: the
      // fake CLI is the subject.
      cardBuilder: 'mechanical',
      verifyEnabled: false,
      storeDbPath: join(dir, 'missing.db'),
      storeDocumentsIndexPath: join(dir, 'missing.json'),
      reconcileMs: 3600000,
    })
    const { agent, scopedHandlers } = createMockAgent('agent-p2', 'session-p2')
    mock.rootHandlers.get('agent/created')({ agent })

    scopedHandlers.get('session/event')(
      { id: 'session-p2' },
      {
        type: 'assistant/message',
        seq: 1,
        time: Date.now(),
        data: { turn: 1, step: 1, message: { id: 'm1', content: [{ type: 'reasoning', text: '这里要统一身份认证，并且保持登录态' }] } },
      },
    )

    const decision = { kind: 'enter', messages: [{ id: 'original' }] }
    const next = () => Promise.resolve(decision)
    const injected = await waitFor(async () => {
      const returned = await scopedHandlers.get('agent/pre-step')({ turn: 1, step: 2, messages: [{}], signal: { aborted: false } }, next)
      if (returned.messages.length <= decision.messages.length) return false
      const message = returned.messages.at(-1)
      assert.equal(message.source.plugin, PLUGIN_NAME)
      assert.match(message.content[0].text, /可能相关的历史经验/)
      assert.match(message.content[0].text, /记忆 id: 11111111/)
      assert.ok(Buffer.byteLength(message.content[0].text) <= 1200)
      return true
    })
    assert.ok(injected, 'the boundary must eventually carry the retrieved experience')

    const again = await scopedHandlers.get('agent/pre-step')({ turn: 1, step: 3, messages: [{}], signal: { aborted: false } }, next)
    assert.equal(again.messages.length, decision.messages.length, 'the same turn must not repeat the injection')

    dispose()
    // The logger is asynchronous by contract, so give the final records a moment
    // to land before asserting on the file.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const text = await readFile(logPath, 'utf8')
    const records = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(records.some((record) => record.kind === 'trigger'))
    assert.ok(records.some((record) => record.kind === 'recall' && record.phase === 'queued'))
    const injection = records.find((record) => record.kind === 'inject' && record.text !== undefined)
    assert.ok(injection !== undefined)
    assert.ok(injection.cards.length >= 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
