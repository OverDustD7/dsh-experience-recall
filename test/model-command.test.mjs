// Tests for the in-session model switch: `/experience-recall model`.
//
// Two layers are covered here: the pure helpers that turn an Ollama `/api/tags`
// payload into options (`lib/models.js`), and the command's decisions with every
// host effect faked (`lib/model-command.js`). The host wiring itself — that a
// switched model reaches the judge — is pinned in `verify.test.mjs`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODEL_USAGE, createModelCommand, parseModelCommand } from '../lib/model-command.js'
import { buildModelQuestion, describeModel, formatBytes, isEmbeddingModel, listLocalModels, parseTags, rankModels, tagsUrl } from '../lib/models.js'

const TAGS = {
  models: [
    { name: 'bge-m3:latest', size: 1161505024, details: { family: 'bert', parameter_size: '566.70M', quantization_level: 'F16' } },
    { name: 'qwen3.5:9b', size: 6603828882, details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' } },
    { name: 'mimo-v2.6:9b-q6_K', size: 7797074842, details: { family: 'mimo', parameter_size: '9.0B', quantization_level: 'Q6_K' } },
    { name: 'qwen3.6:35b-a3b', size: 22624785262, details: { family: 'qwen36moe', parameter_size: '35.5B', quantization_level: 'Q4_K_M' } },
    { size: 1234 },
  ],
}

test('the command line splits into status, help, pick and set', () => {
  assert.equal(parseModelCommand('').action, 'status')
  assert.equal(parseModelCommand('  status ').action, 'status')
  assert.equal(parseModelCommand('help').action, 'help')
  assert.equal(parseModelCommand('?').action, 'help')
  assert.equal(parseModelCommand('model').action, 'pick')
  assert.equal(parseModelCommand('models').action, 'pick')
  assert.equal(parseModelCommand('model ls').action, 'pick')
  assert.equal(parseModelCommand('model qwen3.5:9b').model, 'qwen3.5:9b')
  assert.equal(parseModelCommand('model   qwen3.6:35b-a3b  ').model, 'qwen3.6:35b-a3b', 'the name keeps its own spacing rules')
  assert.equal(parseModelCommand('modell qwen').action, 'unknown')
})

test('the tag payload becomes records, and embedding models are marked', () => {
  const models = parseTags(TAGS)
  assert.equal(models.length, 4, 'an entry without a name is dropped, never guessed at')
  assert.equal(models[0].embedding, true, 'family bert is embedding-only')
  assert.equal(isEmbeddingModel('nomic-embed-text:latest'), true)
  assert.equal(isEmbeddingModel('qwen3.5:9b', { family: 'qwen35' }), false)
  assert.equal(models[1].parameters, '9.7B')
  assert.equal(formatBytes(models[1].sizeBytes), '6.15 GB')
  assert.equal(describeModel(models[1]), '6.15 GB · 9.7B · Q4_K_M')
})

test('the picker shows the current model first, then the smallest chat model', () => {
  const ranked = rankModels(parseTags(TAGS), 'qwen3.6:35b-a3b')
  assert.deepEqual(ranked.options.map((model) => model.name), ['qwen3.6:35b-a3b', 'qwen3.5:9b', 'mimo-v2.6:9b-q6_K'], 'current first; embeddings never listed')
  assert.equal(ranked.embeddings, 1)
  const capped = rankModels(parseTags(TAGS), '', { max: 2 })
  assert.deepEqual(capped.options.map((model) => model.name), ['qwen3.5:9b', 'mimo-v2.6:9b-q6_K'])
  assert.equal(capped.hidden, 1)
  const question = buildModelQuestion({ current: 'qwen3.5:9b', endpoint: 'http://localhost:11434', ...capped })
  assert.match(question.question, /当前：qwen3\.5:9b/)
  assert.match(question.question, /另有 1 个未列出/)
  assert.match(question.question, /已跳过 1 个向量模型/)
  assert.match(question.detail, /端点：http:\/\/localhost:11434/)
  assert.equal(question.options[0].description.startsWith('当前 · '), true)
  assert.equal(question.options[1].description.startsWith('当前'), false)
})

test('the tags fetch reports a stopped Ollama instead of throwing', async () => {
  const ok = await listLocalModels({ endpoint: 'http://localhost:11434/', timeoutMs: 500, fetchImpl: async (url) => {
    assert.equal(url, 'http://localhost:11434/api/tags')
    return { ok: true, json: async () => TAGS }
  } })
  assert.equal(ok.ok, true)
  assert.equal(ok.models.length, 4)
  const broken = await listLocalModels({ endpoint: 'http://localhost:11434', timeoutMs: 500, fetchImpl: async () => { throw new Error('fetch failed') } })
  assert.equal(broken.ok, false)
  assert.match(broken.error, /fetch failed/)
  const http500 = await listLocalModels({ endpoint: 'http://localhost:11434', timeoutMs: 500, fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(http500.ok, false)
  assert.match(http500.error, /HTTP 500/)
  assert.equal(tagsUrl('http://localhost:11434/'), 'http://localhost:11434/api/tags')
})

/** A command with every effect recorded, so decisions can be asserted without a host. */
function commandWith(overrides = {}) {
  const calls = { set: [], persist: [], asked: [], notes: [] }
  const command = createModelCommand({
    getConfig: () => ({ localModel: 'qwen3.5:9b', localEndpoint: 'http://localhost:11434' }),
    setModel: (next) => calls.set.push(next),
    persist: async (next) => {
      calls.persist.push(next)
      return overrides.persist ?? { ok: true }
    },
    listModels: overrides.listModels ?? (async () => ({ ok: true, models: parseTags(TAGS), error: null })),
    ask: async (question) => {
      calls.asked.push(question)
      return overrides.answer ?? { selected: ['mimo-v2.6:9b-q6_K'], custom: '' }
    },
    statusText: () => '经验召回 · 状态行',
    note: (kind, data) => calls.notes.push({ kind, ...data }),
    ...overrides.deps,
  })
  return { command, calls }
}

test('the status path is untouched and an unknown argument explains itself', async () => {
  const { command } = commandWith()
  assert.equal((await command.run('', {})).text, '经验召回 · 状态行')
  const unknown = await command.run('frobnicate', {})
  assert.equal(unknown.kind, 'error')
  assert.ok(unknown.text.includes(MODEL_USAGE))
})

test('a named model is applied live, persisted, and logged', async () => {
  const { command, calls } = commandWith()
  const result = await command.run('model mimo-v2.6:9b-q6_K', { rawInput: 'model mimo-v2.6:9b-q6_K' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /qwen3\.5:9b → mimo-v2\.6:9b-q6_K/)
  assert.match(result.text, /重启后仍然是它/)
  assert.deepEqual(calls.set, ['mimo-v2.6:9b-q6_K'])
  assert.deepEqual(calls.persist, ['mimo-v2.6:9b-q6_K'])
  assert.equal(calls.notes.length, 1)
  assert.equal(calls.notes[0].kind, 'model-changed')
  assert.equal(calls.notes[0].persisted, true)
})

test('a name that is not installed is applied but called out', async () => {
  const { command, calls } = commandWith()
  const result = await command.run('model llama3:8b', {})
  assert.match(result.text, /本机 Ollama 里没看到 llama3:8b/)
  assert.deepEqual(calls.set, ['llama3:8b'], 'a missing name is still usable if Ollama is about to have it')
  assert.equal(calls.notes[0].installed, false)
})

test('an unreachable Ollama is reported, and the name is still written', async () => {
  const { command, calls } = commandWith({ listModels: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') } })
  const result = await command.run('model mimo-v2.6:9b-q6_K', {})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /没能连上 Ollama 校验（connect ECONNREFUSED 127\.0\.0\.1:11434）/)
  assert.deepEqual(calls.set, ['mimo-v2.6:9b-q6_K'])
  assert.equal(calls.notes[0].installed, undefined, 'unknown install state is not recorded as a fact')
})

test('an illegal name is refused before anything is touched', async () => {
  let listed = 0
  const { command, calls } = commandWith({ deps: { listModels: async () => { listed += 1; return { ok: true, models: [] } } } })
  for (const bad of ['model 有中文', 'model a b', 'model -x']) {
    const result = await command.run(bad, {})
    assert.equal(result.kind, 'error', `${bad} must be refused`)
  }
  assert.deepEqual(calls.set, [])
  assert.deepEqual(calls.persist, [])
  assert.equal(listed, 0, 'a bad name is refused without probing Ollama')
})

test('a failed profile write keeps the runtime switch and says it is not persistent', async () => {
  const { command, calls } = commandWith({ persist: { ok: false, reason: '这台宿主没有 configEditor' } })
  const result = await command.run('model mimo-v2.6:9b-q6_K', {})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /本次进程立即生效/)
  assert.match(result.text, /这台宿主没有 configEditor/)
  assert.equal(calls.set.length, 1, 'the runtime value is the part that works')
  assert.equal(calls.notes[0].persisted, false)
})

test('picking from the card applies the choice, and a dismissed card changes nothing', async () => {
  const picked = commandWith()
  const applied = await picked.command.run('model', { rawInput: 'model', agent: { id: 'a1' } })
  assert.match(applied.text, /mimo-v2\.6:9b-q6_K/)
  assert.equal(picked.calls.asked.length, 1)
  assert.equal(picked.calls.asked[0].options.length, 3)
  assert.deepEqual(picked.calls.set, ['mimo-v2.6:9b-q6_K'])

  const dismissed = commandWith({ answer: { selected: [], custom: '' } })
  const unchanged = await dismissed.command.run('model', {})
  assert.equal(unchanged.kind, 'success')
  assert.match(unchanged.text, /没改（仍是 qwen3\.5:9b）/)
  assert.deepEqual(dismissed.calls.set, [])
})

test('a typed "other" answer is honored', async () => {
  const { command, calls } = commandWith({ answer: { selected: [], custom: 'qwen3.8:27b-ud-q3_K_XL' } })
  const result = await command.run('model', {})
  assert.deepEqual(calls.set, ['qwen3.8:27b-ud-q3_K_XL'])
  assert.match(result.text, /qwen3\.8:27b-ud-q3_K_XL/)
})

test('an unreachable Ollama gives the argument form instead of an empty card', async () => {
  const { command, calls } = commandWith({ listModels: async () => ({ ok: false, models: [], error: 'fetch failed' }) })
  const result = await command.run('model', {})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /取本机模型列表失败/)
  assert.match(result.text, /fetch failed/)
  assert.match(result.text, /model <名字>/)
  assert.equal(calls.asked.length, 0, 'no card is shown when there is nothing to choose from')
})

test('an embedding-only install is reported, not offered', async () => {
  const only = { ...TAGS, models: [TAGS.models[0]] }
  const { command } = commandWith({ listModels: async () => ({ ok: true, models: parseTags(only), error: null }) })
  const result = await command.run('model', {})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有可用的对话模型/)
})
