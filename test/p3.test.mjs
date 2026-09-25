// Stage P3 tests: term extraction, the two card builders, the live vocabulary
// table, and the memory-watch that keeps it current.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askLocalModel, createCardBuilder, mechanicalCard, mechanicalTerms } from '../lib/cards.js'
import { createMemoryWatch } from '../lib/memory-watch.js'
import { createTermTable } from '../lib/table.js'
import { excerptOf, extractTerms, isUsableTerm, parseList, trimToBudget } from '../lib/terms.js'
import { matchKeywords } from '../lib/keywords.js'

// ----------------------------------------------------------------- terms ---

test('term filter keeps specifics and rejects generic or numeric noise', () => {
  assert.equal(isUsableTerm('zhjwxk.cic.tsinghua.edu.cn'), true)
  assert.equal(isUsableTerm('cordis.patch.yml'), true)
  assert.equal(isUsableTerm('edu.cn'), false, 'a bare two-label host is noise')
  assert.equal(isUsableTerm('登录'), false)
  assert.equal(isUsableTerm('id'), false)
  assert.equal(isUsableTerm('42'), false)
  assert.equal(isUsableTerm('browser_execute'), true)
  assert.equal(isUsableTerm('统一身份认证'), true)
})

test('term extraction takes structural proper nouns, never free Chinese prose', () => {
  const text = '在 zhjwxk.cic.tsinghua.edu.cn 里用 TextDecoder(\'gbk\') 解码，命令 browser_execute 与 SSO 都要注意；见《选课手册》与 lib/scan.js。这个方案其实挺好的。'
  const terms = extractTerms(text)
  assert.ok(terms.includes('zhjwxk.cic.tsinghua.edu.cn'))
  assert.ok(terms.includes('browser_execute'))
  assert.ok(terms.includes('sso'))
  assert.ok(terms.includes('lib/scan.js'))
  assert.ok(terms.some((term) => term.includes('选课手册')))
  assert.ok(!terms.some((term) => term.includes('这个方案')), 'prose must not become a trigger term')
})

test('parseList accepts JSON arrays and separator-separated text', () => {
  assert.deepEqual(parseList('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseList('a, b、c'), ['a', 'b', 'c'])
  assert.deepEqual(parseList([]), [])
  assert.deepEqual(parseList(null), [])
})

test('excerpt keeps angle-bracket placeholders and trims at a sentence boundary', () => {
  const raw = '文件在 ~/.dsh/sessions/<工作区转义名>/session-<id>/session.v3.jsonl.zstd，是每次 append 写一个 zstd 帧。后面还有很长的说明文字需要被裁掉。'
  const card = excerptOf(raw, 60)
  assert.ok(card.includes('<工作区转义名>'), 'angle brackets must survive: they are placeholders')
  assert.ok(card.includes('<id>'))
  assert.ok(card.length <= 60)
  assert.ok(card.endsWith('。') || card.endsWith('…'))
  assert.equal(trimToBudget('短句。', 100), '短句。')
})

// ----------------------------------------------------------------- cards ---

const MEMORY = {
  id: 'm1',
  content: '清华选课系统 zhjwxk.cic.tsinghua.edu.cn 抓取：GBK 响应要 TextDecoder(\'gbk\')，课余量用 m=kylSearch 串行翻页。',
  tags: ['清华选课', 'zhjwxk'],
  entities: ['TextDecoder'],
}

test('mechanical terms merge author tags with text proper nouns and drop fragments', () => {
  const terms = mechanicalTerms(MEMORY, { limit: 5 })
  assert.ok(terms.includes('zhjwxk') || terms.includes('清华选课'))
  assert.ok(terms.includes('zhjwxk.cic.tsinghua.edu.cn'))
  for (const term of terms) {
    assert.ok(!terms.some((other) => other !== term && other.includes(term)), `fragment kept: ${term}`)
  }
})

test('mechanical card is the cleaned first sentences, inside budget', () => {
  const card = mechanicalCard(MEMORY, { chars: 60 })
  assert.ok(card.length <= 60)
  assert.ok(!card.includes('*'))
})

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }
  }
  impl.calls = calls
  return impl
}

test('local model output is parsed, trimmed to budget, and reports failures without throwing', async () => {
  const ok = await askLocalModel({
    model: 'test-model',
    content: 'x',
    cardChars: 40,
    fetchImpl: fakeFetch({ response: '```json\n{"terms":["zhjwxk","kylSearch","a"],"card":"' + '这是一句很长的卡片内容需要被裁掉。'.repeat(4) + '"}\n```' }),
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.terms.slice(0, 2), ['zhjwxk', 'kylsearch'])
  assert.ok(ok.card.length <= 40)
  assert.ok(ok.trimmed !== undefined, 'an overshooting model card must be reported as trimmed')

  const unparsable = await askLocalModel({ model: 'test-model', content: 'x', fetchImpl: fakeFetch({ response: 'not json at all' }) })
  assert.equal(unparsable.ok, false)
  assert.match(String(unparsable.error), /unparsable/)

  const http = await askLocalModel({ model: 'test-model', content: 'x', fetchImpl: fakeFetch({}, { status: 500 }) })
  assert.equal(http.ok, false)
  assert.match(String(http.error), /HTTP 500/)

  const noModel = await askLocalModel({ model: '', content: 'x', fetchImpl: fakeFetch({ response: '{}' }) })
  assert.equal(noModel.ok, false)
  assert.match(String(noModel.error), /not configured/)
})

test('card builder uses the model when it answers and degrades to mechanical when it does not', async () => {
  const good = createCardBuilder({
    config: { cardBuilder: 'local', localModel: 'test-model', localEndpoint: 'http://x', cardChars: 60 },
    fetchImpl: fakeFetch({ response: '{"terms":["zhjwxk","kylSearch"],"card":"GBK 解码与串行翻页。"}' }),
  })
  const fromModel = await good.build(MEMORY, 'r1')
  assert.equal(fromModel.source, 'local-model')
  // The author's own tags/entities come first, then the model's picks (see the
  // concept-word test below); both halves must be present.
  assert.ok(fromModel.terms.includes('zhjwxk'))
  assert.ok(fromModel.terms.includes('kylsearch'))
  assert.deepEqual(fromModel.terms.slice(-2), ['zhjwxk', 'kylsearch'], 'model picks keep their order after the author terms')
  const cached = await good.build(MEMORY, 'r1')
  assert.equal(cached.source, 'local-model')
  assert.equal(good.stats().cacheHits, 1)

  const broken = createCardBuilder({
    config: { cardBuilder: 'local', localModel: 'test-model', localEndpoint: 'http://x', cardChars: 150 },
    fetchImpl: async () => {
      throw new Error('ollama down')
    },
  })
  const fallback = await broken.build(MEMORY, 'r1')
  assert.equal(fallback.source, 'mechanical')
  assert.ok(fallback.card.length > 0)
  assert.equal(broken.stats().modelFailed, 1)

  const mechanical = createCardBuilder({ config: { cardBuilder: 'mechanical' } })
  assert.equal((await mechanical.build(MEMORY, 'r1')).source, 'mechanical')
})

test('a memory with nothing transferable yields no card at all', async () => {
  // The card prompt asks for the portable lesson and allows an empty one: a pure
  // progress log ("spent ¥4.39 over 135 steps") has nothing another project can use.
  // Such a memory must contribute no card and no terms, so it can never trigger.
  const builder = createCardBuilder({
    config: { cardBuilder: 'local', localModel: 'test-model', localEndpoint: 'http://x' },
    fetchImpl: fakeFetch({ response: '{"terms":["135 步"],"card":"","scope":"private"}' }),
  })
  const built = await builder.build(MEMORY, 'r1')
  assert.equal(built, undefined, 'nothing transferable means no card')
  assert.equal(builder.stats().privateSkipped, 1)
  assert.equal(builder.has('m1'), false, 'and nothing may be cached for it')
})

test('an empty card field is a valid answer, a missing one is a failure', async () => {
  const intentional = await askLocalModel({ model: 'test-model', content: 'x', fetchImpl: fakeFetch({ response: '{"terms":[],"card":"","scope":"private"}' }) })
  assert.equal(intentional.ok, true)
  assert.equal(intentional.scope, 'private')

  const missing = await askLocalModel({ model: 'test-model', content: 'x', fetchImpl: fakeFetch({ response: '{"terms":["a"]}' }) })
  assert.equal(missing.ok, false)
  assert.match(String(missing.error), /empty card/)
})

test('a transient model failure reuses the previous good card instead of degrading it', async () => {
  // Measured 2026-09-19: a re-annotation pass under model contention failed with
  // HTTP 500 and cached *mechanical* fallbacks over cards the model had built.
  let mode = 'ok'
  const builder = createCardBuilder({
    config: { cardBuilder: 'local', localModel: 'test-model', localEndpoint: 'http://x' },
    fetchImpl: async () => {
      if (mode === 'fail') return { ok: false, status: 500, json: async () => ({}) }
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: '{"terms":["zhjwxk"],"card":"GBK 响应要显式解码。","scope":"portable"}' }),
      }
    },
  })
  const good = await builder.build(MEMORY, 'r1')
  assert.equal(good.source, 'local-model')

  // Same memory, new revision (e.g. the store row changed), model now unreachable.
  mode = 'fail'
  const afterFailure = await builder.build(MEMORY, 'r2')
  assert.equal(afterFailure.source, 'local-model', 'the good card must survive a transient failure')
  assert.equal(afterFailure.card, good.card)
  assert.equal(afterFailure.reusedFrom, good.key)
  assert.equal(builder.stats().reusedOnFailure, 1)
})

test('the author tags/entities outrank the model picks, so a concept word can be pinned', async () => {
  // Measured 2026-09-20: the style memory carried the terms of the context it was
  // written in (`问卷`/`自述`) instead of the concept (`说话风格`/`口吻`), so it never
  // fired when the user talked about their tone. Author terms must survive the model.
  const record = { id: 'style', content: '语气保持书面但不官腔', tags: ['说话风格'], entities: ['口吻', '语气'] }
  const builder = createCardBuilder({
    config: { cardBuilder: 'local', localModel: 'test-model', localEndpoint: 'http://x' },
    fetchImpl: fakeFetch({ response: '{"terms":["书面语","第一人称"],"card":"书面但不官腔。","scope":"portable"}' }),
  })
  const built = await builder.build(record, 'r1')
  assert.ok(built.terms.includes('口吻'), `author entity must survive: ${built.terms.join('/')}`)
  assert.ok(built.terms.includes('说话风格'))
  assert.ok(built.terms.includes('书面语'), 'the model picks still contribute')
})

// ----------------------------------------------------------------- table ---

test('the vocabulary table tracks terms per memory and can replace or drop them', () => {
  const table = createTermTable({ seedEntries: [{ term: 'seed-term' }] })
  table.addMany([
    { term: 'zhjwxk', kind: 'memory', memoryId: 'm1', excerpt: 'card one' },
    { term: 'kylSearch', kind: 'memory', memoryId: 'm1', excerpt: 'card one' },
  ])
  assert.equal(table.stats().terms, 3)
  assert.equal(table.stats().memories, 1)
  const hit = matchKeywords('用 kylSearch 翻页', table.current())[0]
  assert.equal(hit.term, 'kylsearch')
  assert.equal(hit.memoryId, 'm1')
  assert.equal(hit.excerpt, 'card one')

  const replaced = table.replaceMemory('m1', [{ term: 'rxSearch', kind: 'memory', memoryId: 'm1', excerpt: 'card two' }])
  assert.deepEqual(replaced, { removed: 2, added: 1 })
  assert.equal(matchKeywords('kylSearch', table.current()).length, 0)
  assert.equal(matchKeywords('rxSearch', table.current())[0].excerpt, 'card two')

  assert.equal(table.removeMemory('m1'), 1)
  assert.equal(table.stats().terms, 1, 'the seed term survives')
})

// ---------------------------------------------------------- memory watch ---

function fakeStore(insights = [], documents = []) {
  const state = { insights, documents, insightError: undefined }
  return {
    state,
    async insights() {
      if (state.insightError !== undefined) return { rows: [], revision: '', error: state.insightError }
      return { rows: state.insights, revision: `r${state.insights.length}` }
    },
    async documents() {
      return { rows: state.documents, revision: `d${state.documents.length}` }
    },
  }
}

function fakeTimers() {
  const scheduled = []
  return {
    scheduled,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      scheduled.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      const index = scheduled.indexOf(handle)
      if (index >= 0) scheduled.splice(index, 1)
    },
    runAll() {
      const pending = scheduled.splice(0, scheduled.length)
      for (const handle of pending) handle.fn()
    },
  }
}

function watchFor(store, timers, config = {}) {
  return createMemoryWatch({
    store,
    builder: createCardBuilder({ config: { cardBuilder: 'mechanical' } }),
    logger: { write: () => {} },
    config: { reconcileDebounceMs: 1000, reconcileMs: 60000, ...config },
    timers,
  })
}

test('watch adds, updates and removes terms as the store changes', async () => {
  const store = fakeStore([{ id: 'm1', content: 'zhjwxk 抓取要用 TextDecoder gbk', tags: ['zhjwxk'], entities: [], updatedAt: 't1' }])
  const watch = watchFor(store, fakeTimers())
  await watch.reconcile('bootstrap')
  assert.equal(matchKeywords('zhjwxk 接口', watch.table.current()).length, 1)
  assert.equal(watch.snapshot().added, 1)

  // Unchanged store: nothing rebuilt on the next pass.
  await watch.reconcile('noop')
  assert.equal(watch.snapshot().updated, 0)

  // Edited memory: its old terms are replaced by the new ones.
  store.state.insights = [{ id: 'm1', content: '改用 rxSearch 重新查询', tags: ['rxSearch'], entities: [], updatedAt: 't2' }]
  await watch.reconcile('edit')
  assert.equal(watch.snapshot().updated, 1)
  assert.equal(matchKeywords('zhjwxk', watch.table.current()).length, 0)
  assert.equal(matchKeywords('rxSearch', watch.table.current()).length, 1)

  // Forgotten memory: its terms disappear.
  store.state.insights = []
  await watch.reconcile('forget')
  assert.equal(watch.snapshot().removed, 1)
  assert.equal(matchKeywords('rxSearch', watch.table.current()).length, 0)
})

test('watch also indexes project documents and survives an unreadable store', async () => {
  const store = fakeStore([], [{ id: 'doc-1', title: 'chat-feed 引用注入', description: '改用 systemPrompt.section 在组装提示词时注入上下文。', updatedAt: 'd1' }])
  const watch = watchFor(store, fakeTimers())
  await watch.reconcile('bootstrap')
  const hit = matchKeywords('systemPrompt.section', watch.table.current())[0]
  assert.equal(hit.memoryId, 'doc:doc-1')
  assert.match(hit.excerpt, /注入/)

  store.state.insightError = 'database is locked'
  await watch.reconcile('broken')
  assert.equal(watch.snapshot().lastError, 'database is locked')
  assert.equal(matchKeywords('systemPrompt.section', watch.table.current()).length, 1, 'the previous table is kept')
})

test('a mnemon tool call schedules a reconcile, other tools do not', async () => {
  const timers = fakeTimers()
  const watch = watchFor(fakeStore(), timers)
  watch.observe({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } })
  assert.equal(timers.scheduled.length, 0)

  watch.observe({ type: 'tool/call', data: { callId: 'c2', name: 'mnemon_remember', arguments: '{"content":"x"}' } })
  assert.equal(watch.snapshot().triggers, 1)
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].ms, 1000)

  timers.runAll()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(watch.snapshot().reconciles, 1)

  // A second mnemon call replaces the pending timer instead of stacking one.
  watch.observe({ type: 'tool/call', data: { callId: 'c3', name: 'mnemon_forget', arguments: '{}' } })
  watch.observe({ type: 'tool/call', data: { callId: 'c4', name: 'mnemon_remember', arguments: '{}' } })
  assert.equal(timers.scheduled.length, 1)
  watch.dispose()
})

test('the periodic safety net fires for writes that bypass the memory tools', async () => {
  const timers = fakeTimers()
  const watch = watchFor(fakeStore(), timers, { reconcileMs: 0 })
  watch.observe({ type: 'session/event' })
  watch.observe({ type: 'assistant/message', data: { turn: 1 } })
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].ms, 0)
  watch.dispose()
})

test('terms carried by most memories are filtered out as non-discriminating', async () => {
  // `pwsh` shows up in nearly every memory; `zhjwxk` only in one. The first is
  // pure noise (measured: it fired on every event of one session).
  const insights = []
  for (let index = 0; index < 12; index += 1) {
    insights.push({ id: `m${index}`, content: `第 ${index} 条经验：用 pwsh 跑命令`, tags: ['pwsh'], entities: [], updatedAt: `t${index}` })
  }
  insights.push({ id: 'special', content: '清华选课系统 zhjwxk.cic.tsinghua.edu.cn 抓取要用 TextDecoder', tags: ['zhjwxk'], entities: [], updatedAt: 'ts' })
  const store = fakeStore(insights)
  const watch = createMemoryWatch({
    store,
    builder: createCardBuilder({ config: { cardBuilder: 'mechanical' } }),
    logger: { write: () => {} },
    config: { reconcileDebounceMs: 1000, reconcileMs: 60000, maxTermDocumentFrequency: 0.2 },
    timers: fakeTimers(),
  })
  await watch.reconcile('ubiquity')
  assert.equal(matchKeywords('pwsh 跑命令', watch.table.current()).length, 0, 'a term in most memories must not trigger')
  // The bare `zhjwxk` tag is folded into the longer host term by the fragment
  // pass, so the surviving term is the specific host — which is the point.
  assert.ok(matchKeywords('访问 zhjwxk.cic.tsinghua.edu.cn 接口', watch.table.current()).length > 0, 'a specific term must survive')
  assert.ok(watch.snapshot().blockedTerms > 0)
})

// ------------------------------------------------------------ card cache ---

test('document fragments split on ## sections and are persisted like other cards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-frag-'))
  try {
    const cachePath = join(dir, 'cards.json')
    const text = [
      '---',
      'title: 浏览器异常排查',
      '---',
      '',
      '前言段落，长度足够被保留下来用于测试片段的过滤。'.repeat(2),
      '',
      '## 现象',
      '窗口隐藏时截图会冻结成重复帧，点击看似无效，实测需要先检查 document.visibilityState。'.repeat(2),
      '',
      '## 修法',
      '用 ShowWindow(hwnd, 4) 代替 SetForegroundWindow，能显示但不抢前台。'.repeat(2),
    ].join('\n')
    const first = createCardBuilder({ config: { cardBuilder: 'mechanical', fragmentChars: 200 }, cachePath })
    await first.load()
    const fragments = first.buildDocumentFragments({ id: 'doc-9', title: '浏览器异常排查', updatedAt: 'd1' }, text, 'd1|100')
    assert.ok(fragments.length >= 2, 'each ## section becomes its own fragment')
    assert.ok(fragments.some((fragment) => fragment.card.includes('现象')))
    assert.ok(fragments.every((fragment) => fragment.memoryId.startsWith('doc:doc-9#')))
    assert.ok(fragments.every((fragment) => Array.isArray(fragment.terms) && fragment.terms.length > 0))
    assert.ok(fragments.every((fragment) => fragment.card.length <= 200))
    await first.save()

    const second = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath })
    await second.load()
    assert.ok(second.stats().persisted >= fragments.length, 'fragments live in the persisted cache too')
    const again = second.buildDocumentFragments({ id: 'doc-9', title: '浏览器异常排查', updatedAt: 'd1' }, text, 'd1|100')
    assert.deepEqual(again, fragments)
    assert.equal(second.stats().fragments, 0, 'a cache hit must not rebuild fragments')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('document cards are persisted too, not just insight cards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-cache-'))
  try {
    const cachePath = join(dir, 'cards.json')
    const document = { id: 'doc-1', title: 'chat-feed 引用注入', description: '改用 systemPrompt.section 在组装提示词时注入上下文。', updatedAt: 'd1' }
    const first = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath })
    await first.load()
    const built = first.buildDocument(document, 'd1|20')
    assert.equal(built.source, 'document')
    assert.ok(built.terms.length > 0)
    await first.save()

    // A fresh builder must see the document half, otherwise the runtime
    // vocabulary silently loses every tier-2 term.
    const second = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath })
    await second.load()
    assert.equal(second.stats().persisted, 1)
    const reloaded = second.buildDocument(document, 'd1|20')
    assert.deepEqual(reloaded, built)
    assert.equal(second.stats().documents, 0, 'a cache hit must not recompute the card')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable cache is never overwritten with a partial one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-cache-'))
  try {
    const cachePath = join(dir, 'cards.json')
    await writeFile(cachePath, '{ this is not json', 'utf8')
    const builder = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath })
    await builder.load()
    await builder.build(MEMORY, 'r1')
    await builder.save()
    assert.equal(await readFile(cachePath, 'utf8'), '{ this is not json', 'the damaged cache must be left alone')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
