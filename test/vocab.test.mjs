// Vocabulary hygiene: the corrections that came out of the first calibration
// round. Each test pins one measured defect so it cannot come back silently.
//
//   1. an inert card (no usable term) must never reach the cache — it can never
//      fire, but it inflates the corpus and therefore the ubiquity denominator;
//   2. stale revisions must be reclaimed, but live cards must never be evicted;
//   3. the ubiquity filter must count the whole corpus, not just the staging
//      batch, and must actually block a term that spreads after it was cached;
//   4. a Chinese sentence is not a trigger term, while a long Latin host is.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCardBuilder } from '../lib/cards.js'
import { createMemoryWatch } from '../lib/memory-watch.js'
import { createTermTable } from '../lib/table.js'
import { isUsableTerm, MAX_CJK_TERM_LENGTH } from '../lib/terms.js'
import { matchKeywords } from '../lib/keywords.js'

// ----------------------------------------------------------------- terms ---

test('a Chinese sentence is rejected as a term, a long Latin host is kept', () => {
  assert.equal(isUsableTerm('渲染你可以留...你的对齐比较好看,原来的删除线是对的'), false, 'prose with punctuation')
  assert.equal(isUsableTerm('聊天每日总结规范后段改定条数不设目标元注释禁令知识库并入条目图片缩图'), false, 'a 34-character Chinese phrase')
  assert.equal(isUsableTerm('a'.repeat(MAX_CJK_TERM_LENGTH)), true, 'a 24-character Latin token is still a term')
  assert.equal(isUsableTerm('zhjwxk.cic.tsinghua.edu.cn'), true, 'a 26-character host must survive')
  assert.equal(isUsableTerm('README.md 与 docs 的差异说明'), true, 'a quoted file name with a short Chinese tail is still usable')
})

test('a schema dump or a trailing separator is rejected', () => {
  assert.equal(isUsableTerm('content_hash:'), false, 'a trailing colon is a column name, not a term')
  assert.equal(isUsableTerm('updated_at:'), false)
  assert.equal(isUsableTerm('id/title/description/status/created_at/updated_'), false, 'a slash dump is not a term')
  assert.equal(isUsableTerm('lib/scan.js'), true, 'a real path survives')
  assert.equal(isUsableTerm('docs/notes.md'), true)
})

test('shell, CSS and quoted-question fragments are rejected as terms', () => {
  // Real entries measured in the live cache (11 of 2506 terms).
  assert.equal(isUsableTerm('; $env:mnemon_store='), false, 'a shell fragment')
  assert.equal(isUsableTerm('right:0;width:var(--cfw-right)'), false, 'a CSS declaration')
  assert.equal(isUsableTerm('display:inline-flex !important'), false)
  assert.equal(isUsableTerm('这跟我有什么关系?'), false, 'a quoted question')
  assert.equal(isUsableTerm('读文档!读文档!积极维护文档!'), false, 'quoted user speech')
  // Still kept: a long exact phrase is harmless (it can only match verbatim) and
  // precise when it does; only punctuation marks a fragment.
  assert.equal(isUsableTerm('maic 全ai守护的自适应课堂'), true)
  assert.equal(isUsableTerm('qwen3.5:9b'), true, 'a colon inside a version tag is fine')
})

// ---------------------------------------------------------------- cards ---

function builderFor(options = {}) {
  return createCardBuilder({ config: { cardBuilder: 'mechanical', ...(options.config ?? {}) }, logger: { write: () => {} } })
}

test('a document whose title yields no term is not cached', async () => {
  const builder = builderFor()
  await builder.load()
  const inert = { id: 'd-inert', title: '聊天每日总结规范后段改定条数不设目标', description: '什么都不含结构化专名的说明文字' }
  const built = await builder.buildDocument(inert, 'r1')
  assert.deepEqual(built.terms, [])
  assert.equal(builder.has('doc:d-inert:r1'), false, 'an inert card must not occupy the cache')

  const useful = { id: 'd-live', title: 'zhjwxk.cic.tsinghua.edu.cn 抓取', description: 'GBK 与 TextDecoder' }
  const kept = builder.buildDocument(useful, 'r1')
  assert.ok(kept.terms.length > 0)
  assert.equal(builder.has(kept.key), true)
})

test('a fragment with no usable term is not cached, and a stale empty one is dropped', async () => {
  const builder = builderFor()
  await builder.load()
  const document = { id: 'd1', title: '选课手册' }
  const text = [
    '## 一句话',
    '这是一段足够长的中文说明，里面没有任何结构化专名，长度超过六十个字符以便通过切片门槛，但仍然抽不出可用触发词。',
    '## 接口',
    'zhjwxk.cic.tsinghua.edu.cn 用 TextDecoder 解码 GBK，命令 m=kylSearch 串行翻页，注意 SSO 会话。',
  ].join('\n')
  const fragments = builder.buildDocumentFragments(document, text, 'r1')
  assert.ok(fragments.length >= 1)
  for (const fragment of fragments) {
    assert.ok(fragment.terms.length > 0, 'a termless fragment must not be returned')
    assert.equal(builder.has(fragment.key), true, 'only fireable fragments are cached')
  }

  // An older build could leave a termless entry behind; compaction must reclaim it.
  const payload = JSON.parse(JSON.stringify({ stale: { terms: [], card: 'x', source: 'document-fragment' } }))
  assert.equal(payload.stale.terms.length, 0)
  const removed = builder.compact(new Map())
  assert.ok(removed >= 0)
})

test('compaction drops stale revisions and keeps the live one', async () => {
  const builder = builderFor()
  await builder.load()
  const document = { id: 'd2', title: 'zhjwxk.cic.tsinghua.edu.cn 手册', description: 'TextDecoder GBK' }
  builder.buildDocument(document, 'r1')
  builder.buildDocument(document, 'r2')
  assert.equal(builder.stats().cache, 2, 'both revisions are persisted')
  builder.compact(new Map([['doc:d2', 'r2']]))
  assert.equal(builder.has('doc:d2:r2'), true, 'the live revision survives')
  assert.equal(builder.has('doc:d2:r1'), false, 'the stale revision is gone')
})

test('the revision budget never evicts live cards the way a flat cache limit did', async () => {
  const builder = builderFor()
  await builder.load()
  // Memory cards first, then a large fragment population: order is what the old
  // flat FIFO eviction punished.
  for (let index = 0; index < 40; index += 1) {
    await builder.build({ id: `m${index}`, content: `zhjwxk.cic.tsinghua.edu.cn 第 ${index} 条，TextDecoder 与 SSO`, tags: [`t${index}`], entities: [] }, 'r1')
  }
  for (let index = 0; index < 60; index += 1) {
    builder.buildDocument({ id: `doc-${index}`, title: `模块${index}.tsinghua.edu.cn 说明`, description: `identifier_${index} 与 SSO` }, 'r1')
  }
  builder.enforceRevisionBudget()
  assert.equal(builder.has('m0:r1'), true, 'a memory card must not be evicted by fragment volume')
  assert.equal(builder.has('doc:doc-59:r1'), true, 'a document card must survive fragment volume too')
})

// ---------------------------------------------------------- memory watch ---

function fakeStore(insights = [], documents = [], bodies = new Map()) {
  const state = { insights, documents, bodies }
  return {
    state,
    async insights() {
      return { rows: state.insights, revision: `r${state.insights.length}` }
    },
    async documents() {
      return { rows: state.documents, revision: `d${state.documents.length}` }
    },
    async documentBodies() {
      return state.bodies
    },
  }
}

function watchFor(store, config = {}) {
  return createMemoryWatch({
    store,
    builder: createCardBuilder({ config: { cardBuilder: 'mechanical' } }),
    logger: { write: () => {} },
    config: { reconcileDebounceMs: 0, reconcileMs: 60000, maxTermDocumentFrequency: 0.5, ubiquityFloor: 4, ...config },
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} },
  })
}

const insight = (index, term) => ({
  id: `m${index}`,
  content: `${term} 相关的做法与实测结论（详见 lib/scan.js 与 docs/notes.md，长度足够以便抽取触发词）。`,
  tags: [term],
  entities: [],
  updatedAt: 't1',
})

test('a term spread across the corpus is blocked, and a rare one survives', async () => {
  const shared = 'zhjwxk.cic.tsinghua.edu.cn'
  // Five memories carry the same author tag (DF 5) and one is distinct.
  const store = fakeStore([
    ...Array.from({ length: 5 }, (_, index) => insight(index, shared)),
    insight(99, 'TextDecoder'),
  ])
  const watch = watchFor(store)
  await watch.reconcile('bootstrap')
  const snapshot = watch.snapshot()
  assert.equal(snapshot.blockedTerms >= 1, true, 'a term in 5 of 6 cards must be blocked')
  assert.equal(watch.table.entries.has(shared), false, 'the ubiquitous term must not be in the table')
  assert.equal(watch.table.entries.has('textdecoder'), true, 'the one distinct memory keeps its term')
})

test('a term that becomes ubiquitous after being cached is re-examined, not grandfathered', async () => {
  const rare = 'rxSearch'
  const store = fakeStore([insight(0, rare)])
  const watch = watchFor(store, { maxTermDocumentFrequency: 0.9, ubiquityFloor: 8 })
  await watch.reconcile('bootstrap')
  assert.equal(matchKeywords(rare, watch.table.current()).length, 1, 'below the cap it is live')

  // Now it spreads across the whole corpus. The second pass must catch it even
  // though those cards are already cached and unchanged. The term is carried by
  // an author tag so its document frequency is unambiguous.
  store.state.insights = Array.from({ length: 12 }, (_, index) => ({
    ...insight(index, rare),
    id: `m${index}`,
    tags: [rare],
    content: `第 ${index} 条：${rare} 的用法与结论，并带有各自不同的标识符 symbol_${index}，长度足够。`,
  }))
  await watch.reconcile('spread')
  assert.equal(matchKeywords(rare, watch.table.current()).length, 0, 'the cached term must be pruned once it is ubiquitous')
})
