// Tiny logging proxy in front of Ollama, used to see the EXACT embedding request
// body a client sends (2026-10-14). It settled a wrong first guess: the mnemon CLI
// sends `{"model":"bge-m3","input":…,"keep_alive":"30m"}` and NO num_ctx, and the
// `num_ctx=262144` in Ollama's "requested context size too large" warning is the
// **default this install fills in**, not something the client asked for. The
// scheduler then clamps it to the model's n_ctx_train (8192) and predicts only
// 1.1 GiB, so the embedding call was never the sawtooth's cause: the loads that
// evicted everything were chat requests that omitted num_ctx on models whose
// Modelfile bakes a huge one (mimo-v2.6 `num_ctx 131072` → 23.3 GiB predicted;
// the vision model at 262144 → 38.3 GiB).
//
// Usage:
//   node tools/embed-probe.mjs                    # listen on 11435, forward to 11434, 3 requests
//   node tools/embed-probe.mjs --port 11435 --target http://localhost:11434 --max 3
// then point the client at it, e.g.
//   $env:MNEMON_EMBED_ENDPOINT='http://localhost:11435'; mnemon recall "..." --limit 1 --brief
//
// Read-only with respect to this project: it writes nothing and only prints.
import { createServer, request as httpRequest } from 'node:http'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const port = Number(argOf('--port', '11435'))
const target = new URL(argOf('--target', 'http://localhost:11434'))
const maxRequests = Number(argOf('--max', '3'))
const idleMs = Number(argOf('--idle-ms', '45000'))

let served = 0
let idleTimer

function stop(reason) {
  console.log(`\n[probe] ${reason}；共转发 ${served} 个请求`)
  process.exit(0)
}

const server = createServer((incoming, outgoing) => {
  const chunks = []
  incoming.on('data', (chunk) => chunks.push(chunk))
  incoming.on('end', () => {
    const body = Buffer.concat(chunks)
    served += 1
    let pretty = body.toString('utf8')
    try {
      pretty = JSON.stringify(JSON.parse(pretty))
    } catch {
      // leave the raw text; a non-JSON body is itself worth seeing
    }
    console.log(`\n[probe] #${served} ${incoming.method} ${incoming.url} (${body.length} B)`)
    console.log(`[probe] body: ${pretty.slice(0, 1200)}`)
    const headers = { ...incoming.headers, host: target.host }
    delete headers['content-length']
    const forwarded = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: incoming.url,
        method: incoming.method,
        headers: { ...headers, 'content-length': body.length },
      },
      (upstream) => {
        outgoing.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(outgoing)
      },
    )
    forwarded.on('error', (error) => {
      console.log(`[probe] upstream error: ${error.message}`)
      outgoing.writeHead(502, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: String(error.message) }))
    })
    forwarded.end(body)
    if (served >= maxRequests) setTimeout(() => stop(`达到 ${maxRequests} 个请求`), 200)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[probe] 监听 http://127.0.0.1:${port} → ${target.origin}（最多 ${maxRequests} 个请求，空闲 ${idleMs} ms 后退出）`)
})
idleTimer = setTimeout(() => stop('空闲超时'), idleMs)
server.on('request', () => {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => stop('空闲超时'), idleMs)
})
