// Debug helper: run the plugin through a mock host with the fake mnemon CLI and
// print every NDJSON record it produced. Useful when an end-to-end expectation
// fails and the log is the only evidence.
//
// Usage: node tools/debug-p2-e2e.mjs
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeCli = join(here, 'fixtures', 'fake-mnemon.mjs')
const dir = await mkdtemp(join(tmpdir(), 'exp-recall-debug-'))
const logPath = join(dir, 'observe.ndjson')

const rootHandlers = new Map()
const ctx = {
  on(event, handler) {
    rootHandlers.set(event, handler)
    return () => rootHandlers.delete(event)
  },
  get() {
    return undefined
  },
  effect(callback) {
    return callback()
  },
}

const dispose = apply(ctx, {
  logPath,
  statsEvery: 1000,
  mnemonCliPath: process.execPath,
  mnemonCliArgs: [fakeCli],
  warmupOnStart: false,
  cooldownMs: 0,
  recallTimeoutMs: 3000,
  cardBuilder: 'mechanical',
  verifyEnabled: false,
  cardCachePath: '',
  storeDbPath: join(dir, 'missing.db'),
  storeDocumentsIndexPath: join(dir, 'missing.json'),
  semanticFallback: false,
})

const scoped = new Map()
const agent = {
  id: 'debug-agent',
  session: { id: 'debug-session' },
  ctx: {
    on(event, handler) {
      scoped.set(event, handler)
      return () => scoped.delete(event)
    },
  },
}
rootHandlers.get('agent/created')({ agent })

scoped.get('session/event')(
  { id: 'debug-session' },
  {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { id: 'm1', content: [{ type: 'reasoning', text: '这里要统一身份认证，并且保持登录态' }] } },
  },
)

const next = () => Promise.resolve({ kind: 'enter', messages: [{ id: 'original' }] })
for (let attempt = 0; attempt < 40; attempt += 1) {
  const returned = await scoped.get('agent/pre-step')({ turn: 1, step: 2, messages: [{}], signal: { aborted: false } }, next)
  if (returned.messages.length > 1) {
    console.log('=== 注入成功（第', attempt, '次边界尝试）===')
    console.log(returned.messages.at(-1).content[0].text)
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
}

dispose()
await new Promise((resolve) => setTimeout(resolve, 100))
const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
console.log('\n=== 插件日志 ===')
for (const line of lines) {
  if (line.text !== undefined) console.log(line.kind, JSON.stringify({ ...line, text: `${line.text.slice(0, 40)}…(${line.bytes}B)` }))
  else console.log(line.kind, JSON.stringify(line))
}
await rm(dir, { recursive: true, force: true })
