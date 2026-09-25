import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { apply } from '../lib/index.js'
import { createObserver } from '../lib/observer.js'
import { createController } from '../lib/controller.js'
import { createVerifier } from '../lib/verify.js'
import { createRecall } from '../lib/recall.js'
import { createCardBuilder, CARD_PROMPT_VERSION } from '../lib/cards.js'
import { createMemoryWatch } from '../lib/memory-watch.js'
import { buildTable, mergeTables, matchKeywords } from '../lib/keywords.js'
import { renderInjection } from '../lib/render.js'
import { createTermTable } from '../lib/table.js'
import { messageVisibleInSurface } from '../lib/surface.js'
import { PLUGIN_NAME, resolveConfig } from '../lib/config.js'
import { defaultStorePaths, readDocuments, readDocumentText } from '../lib/mnemon-store.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const meta = { sessionId: 's', turn: 1, step: 1, text: 'Current work involves a specific task and needs relevant experience to choose the next implementation step.' }
const hit = (term = 'specific', id = term) => ({ term, memoryId: id, excerpt: `Useful lesson ${id}` })
const memory = (id, tag = 'specific') => ({ id, tags: [tag], content: `Experience about ${tag}`, updatedAt: 'r1' })
const config = { cooldownMs: 0, semanticCooldownMs: 0, maxTermDocumentFrequency: 0 }

test('semantic fallback receives text with zero keyword hits and ignores plugin messages', async () => {
  const queries = []
  const controller = createController({ config, recall: { query: async (query) => { queries.push(query); return { rows: [] } } } })
  const observer = createObserver({ table: buildTable([]), onHits: controller.handleHits })
  observer.observe({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: meta.text }] } } }, meta)
  observer.observe({ type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'MUST NOT ENTER CONTEXT' }] } }, meta)
  controller.maybeSemanticFallback(meta)
  await tick()
  assert.equal(queries.length, 1)
  assert.match(queries[0], /Current work/)
  assert.doesNotMatch(queries[0], /MUST NOT/)
})

test('specific candidates beyond the first three hits are ranked first', async () => {
  const judged = []
  const controller = createController({ config, verify: { verify: async (_, card) => { judged.push(card); return { useful: true } } } })
  controller.handleHits([hit('a'), hit('bb'), hit('ccc'), hit('long-specific-identifier')], meta)
  await tick()
  assert.match(judged[0], /long-specific-identifier/)
})

for (const action of ['invalidate', 'reset', 'new-turn', 'dispose']) {
  test(`a pending judgement is discarded after ${action}`, async () => {
    const gate = deferred()
    const controller = createController({ config, verify: { verify: () => gate.promise } })
    controller.handleHits([hit()], meta)
    await tick()
    if (action === 'new-turn') controller.handleHits([], { ...meta, turn: 2 })
    else if (action === 'dispose') controller.dispose()
    else controller[action]('s', 'test')
    gate.resolve({ useful: true })
    await tick()
    assert.equal(controller.snapshot().pending, 0)
    assert.equal(controller.snapshot().accepted, 0)
  })
}

test('a pending recall cannot repopulate candidates after compaction', async () => {
  const gate = deferred()
  let calls = 0
  const controller = createController({ config, recall: { query: () => gate.promise }, verify: { verify: async () => { calls++; return { useful: true } } } })
  controller.handleHits([{ term: 'seed' }], meta)
  await tick()
  controller.invalidate('s', 'compaction')
  gate.resolve({ rows: [{ id: 'a', excerpt: 'old lesson' }] })
  await tick()
  assert.equal(calls, 0)
  assert.equal(controller.snapshot().pending, 0)
})

test('all recall candidates up to maxCards are judged independently', async () => {
  const controller = createController({ config, recall: { query: async () => ({ rows: [{ id: 'bad', excerpt: 'bad' }, { id: 'good', excerpt: 'good' }] }) }, verify: { verify: async (_, card) => ({ useful: card === 'good' }) } })
  controller.handleHits([{ term: 'seed' }], meta)
  await tick()
  assert.equal(controller.snapshot().pending, 1)
  assert.match(controller.takeMessage(meta).content[0].text, /good/)
})

test('only rendered cards are marked injected and overflow is retained', async () => {
  const controller = createController({ config: { ...config, maxInjectBytes: 500 } })
  controller.handleHits([{ term: 'alpha', memoryId: 'alpha', excerpt: '甲'.repeat(80) }, { term: 'bravo', memoryId: 'bravo', excerpt: '乙'.repeat(80) }], meta)
  await tick()
  const first = controller.takeMessage(meta)
  assert.ok(first)
  assert.equal(controller.snapshot().cards, 1)
  assert.equal(controller.snapshot().pending, 1)
  assert.equal(controller.takeMessage(meta), undefined, 'one injection per step')
  assert.ok(controller.takeMessage({ ...meta, step: 2 }))
  assert.equal(controller.snapshot().cards, 2)
})

test('new turns reset quotas even with semantic fallback disabled', async () => {
  const controller = createController({ config: { ...config, semanticFallback: false, maxInjectionsPerTurn: 1 } })
  controller.handleHits([hit()], meta)
  await tick()
  assert.ok(controller.takeMessage(meta))
  controller.maybeSemanticFallback({ ...meta, turn: 2 })
  assert.equal(controller.sessions.get('s').injections, 0)
})

test('inconclusive judgements never damage term reputation', async () => {
  const controller = createController({ config: { ...config, termRejectLimit: 1 }, verify: { verify: async () => ({ useful: false, inconclusive: true }) } })
  controller.handleHits([hit()], meta)
  await tick()
  assert.equal(controller.snapshot().termCooldowns, 0)
})

test('repeat detection expires each signature even during continuous tool traffic', () => {
  const controller = createController({ config: { ...config, repeatToolLimit: 3, repeatWindowSteps: 3 } })
  for (let step = 1; step <= 20; step++) controller.noteToolCall({ ...meta, step, name: 'tool', arguments: [1, 10, 20].includes(step) ? 'same' : `different-${step}` })
  assert.equal(controller.snapshot().repeatTriggers, 0)
})

function childWithoutClose() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = () => {}
  child.kill = () => false
  return child
}

test('verifier and recall time out even when the child never emits close', async () => {
  const verifier = createVerifier({ config: { verifyTimeoutMs: 20 }, spawnImpl: childWithoutClose })
  const recall = createRecall({ config: { mnemonCliPath: 'fake', recallTimeoutMs: 20 }, spawnImpl: childWithoutClose })
  const result = await Promise.all([verifier.verify('ctx', 'card'), recall.query('query')])
  assert.equal(result[0].inconclusive, true)
  assert.equal(result[1].timedOut, true)
  assert.equal(recall.stats().inflight, 0)
})

test('a null verifier response is inconclusive, never a rejected promise', async () => {
  const verifier = createVerifier({ spawnImpl: () => {
    const child = childWithoutClose()
    child.stdin.end = () => setImmediate(() => { child.stdout.emit('data', 'null'); child.emit('close', 0) })
    return child
  } })
  assert.equal((await verifier.verify('ctx', 'card')).inconclusive, true)
})

test('configured endpoint reaches the real checker subprocess', async () => {
  let received
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received = JSON.parse(body)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ response: '{"useful":true,"why":"local stub"}' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const verifier = createVerifier({ config: { localEndpoint: `http://127.0.0.1:${server.address().port}/`, localModel: 'stub-model', verifyTimeoutMs: 3000 } })
    assert.equal((await verifier.verify('context', 'card')).useful, true)
    assert.equal(received.model, 'stub-model')
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('surface visibility includes injections beyond node 2000', () => {
  const session = { surface: { nodes: Array.from({ length: 2101 }, (_, index) => index) }, eventAt: (seq) => seq === 2100 ? { type: 'user/message', data: { id: 'injection', source: { kind: 'plugin', plugin: PLUGIN_NAME } } } : undefined }
  assert.equal(messageVisibleInSurface(session, (id) => id === 'injection'), true)
})

test('rendering preserves placeholders and table merges preserve excerpts', () => {
  assert.match(renderInjection([{ id: 'a', excerpt: 'session-<id> uses value > 0' }]), /session-<id> uses value > 0/)
  const merged = mergeTables(buildTable([hit()]), [{ term: 'other' }])
  assert.equal(matchKeywords('specific', merged)[0].excerpt, hit().excerpt)
})

test('shared terms transfer to a surviving memory when their first owner is removed', () => {
  const table = createTermTable()
  table.add({ term: 'shared', memoryId: 'a', excerpt: 'first' })
  table.add({ term: 'shared', memoryId: 'b', excerpt: 'second' })
  table.removeMemory('a')
  assert.equal(table.entries.get('shared').memoryId, 'b')
  table.removeMemory('b')
  assert.equal(table.stats().terms, 0)
})

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('an invalid document index is an error, not an authoritative empty store', async (t) => {
  const dir = await temporary(t)
  const path = join(dir, 'index.json')
  await writeFile(path, '{}')
  assert.match((await readDocuments({ indexPath: path })).error, /documents/)
})

test('document reads enforce root containment and a byte bound', async (t) => {
  const dir = await temporary(t)
  const root = join(dir, 'root')
  await mkdir(root)
  await writeFile(join(dir, 'outside.txt'), 'outside')
  await writeFile(join(root, 'large.md'), '甲'.repeat(100000))
  assert.equal(await readDocumentText(root, '../outside.txt'), undefined)
  const text = await readDocumentText(root, 'large.md')
  assert.ok(Buffer.byteLength(text) <= 200000)
  assert.doesNotMatch(text, /�/)
})

test('DSH_HOME and configured memory stores agree across index and recall paths', () => {
  const oldHome = process.env.DSH_HOME
  const oldData = process.env.MNEMON_DATA_DIR
  try {
    process.env.DSH_HOME = join(tmpdir(), 'isolated-dsh')
    delete process.env.MNEMON_DATA_DIR
    const resolved = resolveConfig({ mnemonStore: 'alternate' })
    const paths = defaultStorePaths(resolved)
    assert.equal(paths.dbPath, join(resolved.mnemonDataDir, 'data', 'alternate', 'mnemon.db'))
    assert.equal(paths.documentsRoot, join(process.env.DSH_HOME, 'mnemon'))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldData === undefined) delete process.env.MNEMON_DATA_DIR; else process.env.MNEMON_DATA_DIR = oldData
  }
})

test('cache schema failures preserve the original bytes', async (t) => {
  const dir = await temporary(t)
  const path = join(dir, 'cards.json')
  await writeFile(path, '{"unexpected":"data"}')
  const builder = createCardBuilder({ cachePath: path })
  await builder.load()
  await builder.build(memory('a'), 'r1')
  await builder.save()
  assert.equal(await readFile(path, 'utf8'), '{"unexpected":"data"}')
})

test('a failed cache save is retried even without further edits', async (t) => {
  const dir = await temporary(t)
  const parent = join(dir, 'parent')
  const path = join(parent, 'cards.json')
  const builder = createCardBuilder({ cachePath: path })
  await builder.load()
  await builder.build(memory('a'), 'r1')
  await writeFile(parent, 'block directory creation')
  await builder.save()
  await rm(parent)
  await builder.save()
  assert.ok(JSON.parse(await readFile(path, 'utf8')).cards['a:r1'])
  assert.equal(builder.stats().persisted, 1)
})

test('an authoritative empty live set removes forgotten cards from memory', async () => {
  const builder = createCardBuilder()
  await builder.build(memory('a'), 'r1')
  builder.compact(new Map())
  assert.equal(builder.stats().cache, 0)
})

test('unreadable document index at startup cannot compact a good disk cache', async (t) => {
  const dir = await temporary(t)
  const path = join(dir, 'cards.json')
  const initial = createCardBuilder({ cachePath: path })
  initial.buildDocument({ id: 'doc', title: 'special.example.cn' }, 'r1')
  await initial.save()
  const before = await readFile(path, 'utf8')
  const builder = createCardBuilder({ cachePath: path })
  const watch = createMemoryWatch({ builder, config, store: { insights: async () => ({ rows: [memory('a')] }), documents: async () => ({ rows: [], error: 'unreadable' }) } })
  await watch.reconcile()
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(watch.snapshot().reconciles, 0)
})

test('temporarily missing document bodies preserve fragment terms', async () => {
  let bodies = new Map([['doc', '## Fragment heading\n' + 'special.example.cn useful content '.repeat(5)]])
  const watch = createMemoryWatch({ config, builder: createCardBuilder(), store: { insights: async () => ({ rows: [] }), documents: async () => ({ rows: [{ id: 'doc', title: 'Title', description: '', updatedAt: 'r1', relativePath: 'documents/doc.md' }] }), documentBodies: async () => bodies } })
  await watch.reconcile()
  const before = watch.table.stats().terms
  assert.ok(before > 0)
  bodies = new Map()
  await watch.reconcile()
  assert.equal(watch.table.stats().terms, before)
  assert.match(watch.snapshot().lastError, /unreadable document body/)
})

test('the card prompt version is part of the memory revision, so cached cards go stale instead of orphaned', async () => {
  // The version must live where the revision is computed (memory-watch), not inside
  // build(): `compact()` prunes cache entries whose revision nobody declares, so a
  // version hidden in the key would make every live card look like an orphan — the
  // shape of the 2026-09-14 cache wipe (DEV_NOTES 4.9.9).
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-version-'))
  const cachePath = join(dir, 'cards.json')
  const store = { insights: async () => ({ rows: [memory('m-version', 'zhjwxk 抓取要用 TextDecoder')] }), documents: async () => ({ rows: [] }) }
  const first = createMemoryWatch({ config: { ...config, cardCachePath: cachePath }, builder: createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath, logger: { write: () => {} } }), store })
  await first.reconcile()
  const keys = Object.keys(JSON.parse(await readFile(cachePath, 'utf8')).cards)
  assert.equal(keys.length, 1)
  assert.ok(keys[0].startsWith(`m-version:${CARD_PROMPT_VERSION}|`), `key must carry the prompt version: ${keys[0]}`)

  // A second watch over the same cache rebuilds nothing: the revision is unchanged.
  const second = createMemoryWatch({ config: { ...config, cardCachePath: cachePath }, builder: createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath, logger: { write: () => {} } }), store })
  await second.reconcile()
  assert.equal(second.snapshot().compacted, 0, 'a matching revision must not be compacted away')
  assert.equal(Object.keys(JSON.parse(await readFile(cachePath, 'utf8')).cards).length, 1)
})

test('a newly ubiquitous term disappears from unchanged in-memory cards', async () => {
  let rows = [memory('a', 'shared')]
  const watch = createMemoryWatch({ config: { maxTermDocumentFrequency: 0.02, ubiquityFloor: 4 }, builder: createCardBuilder(), store: { insights: async () => ({ rows }), documents: async () => ({ rows: [] }) } })
  await watch.reconcile()
  assert.ok(watch.table.entries.has('shared'))
  rows = Array.from({ length: 5 }, (_, i) => memory(i === 0 ? 'a' : String(i), 'shared'))
  await watch.reconcile()
  assert.equal(watch.table.entries.has('shared'), false)
})

test('disposing a watch stops queued reconciliation and prevents save after an await', async () => {
  const gate = deferred()
  let reads = 0
  let saves = 0
  const builder = createCardBuilder()
  builder.save = async () => { saves++ }
  const watch = createMemoryWatch({ config, builder, store: { insights: async () => { reads++; return gate.promise }, documents: async () => ({ rows: [] }) } })
  const running = watch.reconcile()
  watch.reconcile('queued')
  watch.dispose()
  gate.resolve({ rows: [memory('a')] })
  await running
  await tick()
  assert.ok(reads <= 1)
  assert.equal(saves, 0)
})

test('split UTF-8 subprocess output preserves Chinese verdicts and excerpts', async () => {
  const spawnImpl = (payload) => () => {
    const child = childWithoutClose()
    child.stdout = new PassThrough()
    setImmediate(() => {
      const bytes = Buffer.from(JSON.stringify(payload))
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
      child.stdout.end()
      child.emit('close', 0)
    })
    return child
  }
  const verifier = createVerifier({ spawnImpl: spawnImpl({ useful: true, why: '保持登录态' }) })
  const recall = createRecall({ config: { mnemonCliPath: 'fake' }, spawnImpl: spawnImpl({ results: [{ id: 'a', excerpt: '保持登录态' }] }) })
  assert.equal((await verifier.verify('ctx', 'card')).why, '保持登录态')
  assert.equal((await recall.query('query')).rows[0].excerpt, '保持登录态')
})

test('tool timing does not pair identical call IDs across sessions', () => {
  const records = []
  const observer = createObserver({ logger: { write: (row) => records.push(row) } })
  const data = { turn: 1, step: 1, callId: 'same', name: 'tool' }
  observer.observe({ type: 'tool/call', time: 10, data }, { sessionId: 'a' })
  observer.observe({ type: 'tool/call', time: 50, data }, { sessionId: 'b' })
  observer.observe({ type: 'tool/result', time: 20, data: { turn: 1, step: 1, message: { source: { callId: 'same' } } } }, { sessionId: 'a' })
  assert.equal(records.find((row) => row.kind === 'timing').toolMs, 10)
})

function mockHost() {
  const handlers = new Map()
  return { handlers, ctx: { on: (event, callback) => { handlers.set(event, callback); return () => handlers.delete(event) }, get: () => undefined, effect: (callback) => callback() } }
}

function pluginConfig(dir) {
  return { stateDir: dir, cardCachePath: '', storeDbPath: join(dir, 'missing.db'), storeDocumentsIndexPath: join(dir, 'missing.json'), cardBuilder: 'mechanical', verifyEnabled: false, warmupOnStart: false, semanticFallback: false, mnemonCliPath: '', systemPromptNote: false, keywords: [hit()] }
}

test('a partially failed agent subscription rolls back its earlier listeners', async (t) => {
  const dir = await temporary(t)
  const host = mockHost()
  const handlers = new Map()
  const dispose = apply(host.ctx, pluginConfig(dir))
  const agent = { id: 'a', session: { id: 's' }, ctx: { on(event, callback) {
    if (event === 'agent/session-start') throw new Error('deliberate subscription failure')
    handlers.set(event, callback)
    return () => handlers.delete(event)
  } } }
  host.handlers.get('agent/created')({ agent })
  assert.equal(handlers.size, 0)
  dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
})

test('session switches use the live session and aborted boundaries retain ready cards', async (t) => {
  const dir = await temporary(t)
  const host = mockHost()
  const handlers = new Map()
  const dispose = apply(host.ctx, pluginConfig(dir))
  const agent = { id: 'a', session: { id: 'old' }, ctx: { on(event, callback) { handlers.set(event, callback); return () => handlers.delete(event) } } }
  host.handlers.get('agent/created')({ agent })
  agent.session = { id: 'new' }
  handlers.get('agent/session-start')({ source: 'switch' })
  handlers.get('session/event')(agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'specific experience needed for current work' }] } } })
  await tick()
  const next = async () => ({ kind: 'enter', messages: [] })
  const aborted = await handlers.get('agent/pre-step')({ turn: 1, step: 2, signal: { aborted: true } }, next)
  assert.equal(aborted.messages.length, 0)
  const active = await handlers.get('agent/pre-step')({ turn: 1, step: 2 }, next)
  assert.equal(active.messages.length, 1)
  dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
})
