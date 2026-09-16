// Cache safety: the persisted card index is expensive to rebuild (one local model
// call per memory) and it feeds the ubiquity policy, so a mistaken write must not
// be able to wipe it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCardBuilder } from '../lib/cards.js'

test('a normal incremental save still writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exprec-cache-'))
  try {
    const cachePath = join(dir, 'cards.json')
    const builder = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath, logger: { write: () => {} } })
    await builder.load()
    await builder.build({ id: 'm1', content: 'zhjwxk.cic.tsinghua.edu.cn 抓取，TextDecoder 与 SSO', tags: [], entities: [] }, 'r1')
    await builder.save()
    const after = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(Object.keys(after.cards).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a save that would shrink the cache catastrophically is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exprec-cache-'))
  try {
    const cachePath = join(dir, 'cards.json')
    // A full cache on disk: 200 cards, as built by the real indexer (with ids).
    const cards = {}
    for (let index = 0; index < 200; index += 1) {
      cards[`m${index}:r1`] = { id: `m${index}`, terms: [`term${index}`], card: `card ${index}`, source: 'mechanical', key: `m${index}:r1` }
    }
    await writeFile(cachePath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), cards }), 'utf8')

    const builder = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath, logger: { write: () => {} } })
    await builder.load()
    assert.equal(builder.stats().persisted, 200)

    // A compaction that only knows about one card cannot explain the loss of 200:
    // this is the shape of the accident (a small fixture pointed at the real cache).
    await builder.build({ id: 'fixture', content: 'zhjwxk.cic.tsinghua.edu.cn 抓取，TextDecoder 与 SSO', tags: [], entities: [] }, 'r1')
    builder.compact(new Map([['fixture', 'r1']]))
    await builder.save()

    const after = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(Object.keys(after.cards).length, 200, 'the good cache must survive a fixture-driven save')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an orphaned card is reclaimed when the store no longer declares it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exprec-cache-'))
  try {
    const cachePath = join(dir, 'cards.json')
    const builder = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath, logger: { write: () => {} } })
    await builder.load()
    await builder.build({ id: 'm1', content: 'zhjwxk.cic.tsinghua.edu.cn 抓取，TextDecoder 与 SSO', tags: [], entities: [] }, 'r1')
    await builder.build({ id: 'm2', content: 'rxSearch 与 GBK 解码，SSO 会话', tags: [], entities: [] }, 'r1')
    assert.equal(builder.stats().cache, 2)

    // m2 is gone from the store (forgotten / archived); its card must go with it,
    // or it stays in the vocabulary and in the ubiquity denominator forever.
    const removed = builder.compact(new Map([['m1', 'r1']]))
    assert.equal(removed, 1)
    assert.equal(builder.has('m1:r1'), true)
    assert.equal(builder.has('m2:r1'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a revision full of colons is not mistaken for an orphan', async () => {
  const builder = createCardBuilder({ config: { cardBuilder: 'mechanical' }, logger: { write: () => {} } })
  // Real revision shape: `<updatedAt>|<length>`, and an ISO timestamp is all colons.
  const revision = '2026-09-14T09:21:07Z|821'
  const built = await builder.build(
    { id: 'm1', content: 'zhjwxk.cic.tsinghua.edu.cn 抓取，TextDecoder 与 SSO', tags: [], entities: [] },
    revision,
  )
  assert.equal(built.key, `m1:${revision}`)
  assert.equal(built.id, 'm1', 'the card must carry its own identity')
  assert.equal(builder.stableIdOf(built), 'm1')
  assert.equal(builder.revisionOf(built.key, 'm1'), revision)

  // Measured failure this pins: the id used to be derived by splitting the key at
  // the last colon, so every live card looked like an orphan and compaction deleted
  // 1084 of 1095 of them.
  assert.equal(builder.compact(new Map([['m1', revision]])), 0, 'a live card must survive compaction')
  assert.equal(builder.has(built.key), true)
})

test('document and fragment cards carry their own id, so colons cannot orphan them', async () => {
  const builder = createCardBuilder({ config: { cardBuilder: 'mechanical' }, logger: { write: () => {} } })
  const revision = '2026-09-14T09:21:07Z|1024'
  const document = { id: 'd1', title: 'zhjwxk.cic.tsinghua.edu.cn 选课手册', description: 'TextDecoder 解 GBK' }
  const doc = builder.buildDocument(document, revision)
  assert.equal(doc.id, 'doc:d1')
  const text = '## 接口\nzhjwxk.cic.tsinghua.edu.cn 用 TextDecoder 解码 GBK，命令 m=kylSearch 串行翻页，注意 SSO 会话。'
  const fragments = builder.buildDocumentFragments(document, text, revision)
  assert.ok(fragments.length >= 1)
  const live = new Map([
    ['doc:d1', revision],
    ...fragments.map((fragment) => [fragment.id, revision]),
  ])
  for (const fragment of fragments) assert.match(fragment.id, /^doc:d1#\d+$/)
  assert.equal(builder.compact(live), 0, 'live documents and fragments must all survive')
  for (const fragment of fragments) assert.equal(builder.has(fragment.key), true)
})

test('a save is refused when the store declares far more cards than are written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exprec-cache-'))
  try {
    const cachePath = join(dir, 'cards.json')
    const seed = {
      version: 1,
      savedAt: new Date().toISOString(),
      cards: Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((id) => [`${id}:r1`, { id, terms: [`term-${id}`], card: `card ${id}`, source: 'mechanical', key: `${id}:r1` }]),
      ),
    }
    await writeFile(cachePath, JSON.stringify(seed), 'utf8')
    const builder = createCardBuilder({ config: { cardBuilder: 'mechanical' }, cachePath, logger: { write: () => {} } })
    await builder.load()
    assert.equal(builder.stats().persisted, 4)

    // The store claims 100 cards are live while the cache holds 4: the shape of the
    // accident that emptied this cache (declared 1095, wrote 11). Refuse to write.
    const declared = new Map(Array.from({ length: 100 }, (_, index) => [`m${index}`, 'r1']))
    builder.compact(declared)
    await builder.save()
    const after = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(Object.keys(after.cards).length, 4, 'the good cache must survive a nonsensical shrink')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
