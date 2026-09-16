// Registration-level tests: the plugin must mount on any host context without
// throwing, must own every listener it registers, and must write its evidence
// log. The host context is a mock, so these tests never need a live DSH.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { createLogger } from '../lib/log.js'

function createMockCtx({ throwOnSubscribe = false } = {}) {
  const rootHandlers = new Map()
  const effects = []
  return {
    rootHandlers,
    effects,
    ctx: {
      on(event, handler) {
        if (throwOnSubscribe) throw new Error('subscribe refused')
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

function createMockAgent(id = 'a1', sessionId = 's1') {
  const scopedHandlers = new Map()
  const disposed = []
  return {
    scopedHandlers,
    disposed,
    agent: {
      id,
      session: { id: sessionId },
      ctx: {
        on(event, handler) {
          scopedHandlers.set(event, handler)
          return () => {
            disposed.push(event)
            scopedHandlers.delete(event)
          }
        },
      },
    },
  }
}

/** Config that keeps a test hermetic: no CLI, no model, no real memory store. */
function hermetic(prefix) {
  return {
    mnemonCliPath: '',
    warmupOnStart: false,
    cardBuilder: 'mechanical',
    verifyEnabled: false,
    storeDbPath: `${prefix}.db`,
    storeDocumentsIndexPath: `${prefix}.json`,
    reconcileMs: 3600000,
  }
}

test('the status command registers directly when the service is already there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-cmd-'))
  try {
    const registrations = []
    const commands = {
      register(definition) {
        registrations.push(definition)
        return () => {
          definition.disposed = true
        }
      },
    }
    const rootHandlers = new Map()
    const ctx = {
      on(event, handler) {
        rootHandlers.set(event, handler)
        return () => rootHandlers.delete(event)
      },
      get(name) {
        return name === 'commands' ? commands : undefined
      },
      inject() {
        throw new Error('should not need to wait when the service is visible')
      },
      effect(callback) {
        return callback()
      },
    }
    apply(ctx, { logPath: join(dir, 'observe.ndjson'), ...hermetic(join(dir, 'missing')) })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].name, 'experience-recall')
    const result = registrations[0].handler({ rawInput: '' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /经验召回/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the status command waits for a late commands service instead of skipping silently', async () => {
  // Measured failure: a one-shot ctx.get('commands') check skipped registration
  // entirely when the service was not visible yet, so /experience-recall never
  // existed. The fix waits through ctx.inject; this test pins that behaviour.
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-cmd-'))
  try {
    const registrations = []
    const logged = []
    let pending
    const rootHandlers = new Map()
    const ctx = {
      on(event, handler) {
        rootHandlers.set(event, handler)
        return () => rootHandlers.delete(event)
      },
      get() {
        return undefined
      },
      inject(deps, callback) {
        pending = { deps, callback }
        return { dispose() {} }
      },
      effect(callback) {
        return callback()
      },
    }
    apply(ctx, { logPath: join(dir, 'observe.ndjson'), ...hermetic(join(dir, 'missing')) })
    assert.equal(registrations.length, 0, 'nothing may be registered before the service appears')
    assert.ok(pending !== undefined, 'the plugin must wait for the commands service')
    assert.deepEqual(pending.deps, ['commands'])

    // The service appears later: the injected callback must register the command.
    pending.callback({ commands: { register: (definition) => {
      registrations.push(definition)
      return () => {}
    } } })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].name, 'experience-recall')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function waitForFile(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`log file never appeared: ${path}`)
}

test('plugin identity matches its package name and declares no hard service', () => {
  assert.equal(name, 'dsh-experience-recall')
  assert.ok(Array.isArray(inject))
})

test('apply registers the lifecycle, adopts created agents, and logs evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-'))
  const logPath = join(dir, 'observe.ndjson')
  try {
    const mock = createMockCtx()
    // Retrieval and the store are disabled here: this test owns the observation
    // path, and the local card builder would otherwise call a real model.
    const dispose = apply(mock.ctx, {
      logPath,
      statsEvery: 1000,
      ...hermetic(join(dir, 'missing')),
    })
    assert.equal(typeof dispose, 'function')
    assert.ok(mock.rootHandlers.has('agent/created'))
    assert.equal(mock.effects.length, 1)

    const { agent, scopedHandlers } = createMockAgent('agent-1', 'session-1')
    mock.rootHandlers.get('agent/created')({ agent })
    assert.deepEqual([...scopedHandlers.keys()].sort(), ['agent/pre-step', 'agent/session-start', 'session/event'])

    scopedHandlers.get('session/event')(
      { id: 'session-1' },
      {
        type: 'assistant/message',
        seq: 12,
        time: 1789375705593,
        data: { turn: 1, step: 2, message: { id: 'm1', content: [{ type: 'reasoning', text: '我需要清华 id 登录并保持登录态' }] } },
      },
    )

    const decision = { kind: 'enter', messages: [] }
    const returned = await scopedHandlers.get('agent/pre-step')({ turn: 1, step: 3, messages: [{}], signal: { aborted: false } }, () => Promise.resolve(decision))
    assert.equal(returned, decision, 'pre-step must stay a pass-through while the plugin only observes')

    dispose()
    const text = await waitForFile(logPath)
    const records = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(records.some((record) => record.kind === 'ready' && record.stage === 'P3-live-vocabulary'))
    assert.ok(records.some((record) => record.kind === 'agent-installed' && record.agentId === 'agent-1'))
    const hit = records.find((record) => record.kind === 'event' && record.hits !== undefined)
    assert.ok(hit !== undefined, 'the injected reasoning text must produce a keyword hit')
    assert.ok(hit.hits.some((entry) => entry.term === '清华 id' || entry.term === '登录态'))
    assert.ok(records.some((record) => record.kind === 'prestep' && record.step === 3))
    assert.ok(records.some((record) => record.kind === 'stopped'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dispose removes the root listener and every agent listener', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-'))
  try {
    const mock = createMockCtx()
    const dispose = apply(mock.ctx, { logPath: join(dir, 'observe.ndjson'), ...hermetic(join(dir, 'missing')) })
    const { agent, disposed } = createMockAgent('agent-9', 'session-9')
    mock.rootHandlers.get('agent/created')({ agent })
    dispose()
    assert.equal(mock.rootHandlers.has('agent/created'), false)
    assert.deepEqual(disposed.sort(), ['agent/pre-step', 'agent/session-start', 'session/event'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply stays inert when disabled and never throws on a hostile host context', () => {
  const enabled = createMockCtx()
  assert.equal(apply(enabled.ctx, { enabled: false }), undefined)
  assert.equal(enabled.effects.length, 0)

  const hostile = createMockCtx({ throwOnSubscribe: true })
  assert.doesNotThrow(() =>
    apply(hostile.ctx, { logPath: join(tmpdir(), 'never-written.ndjson'), ...hermetic(join(tmpdir(), 'never-written')) }),
  )
})

test('logger never throws, reports the failure, and rotates on size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-recall-log-'))
  try {
    const blocked = join(dir, 'a-file')
    await writeFile(blocked, 'not a directory')
    const broken = createLogger({ path: join(blocked, 'observe.ndjson') })
    assert.doesNotThrow(() => broken.write({ kind: 'ready' }))
    await broken.flush()
    assert.notEqual(broken.stats().lastError, null)
    assert.equal(broken.stats().failures, 1)

    const path = join(dir, 'rotating.ndjson')
    const rotating = createLogger({ path, maxBytes: 200 })
    for (let index = 0; index < 40; index += 1) rotating.write({ kind: 'event', index, padding: 'x'.repeat(40) })
    await rotating.flush()
    const rotated = await readFile(`${path}.1`, 'utf8')
    assert.ok(rotated.trim().split('\n').length > 0)
    assert.ok(rotating.stats().lines >= 40)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
