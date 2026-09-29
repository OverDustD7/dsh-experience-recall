// dsh-experience-recall · Host plugin entry (stage P2).
//
// Flow, all inside the host process:
//   session/event  -> observer scans increments (reasoning / body / tool args /
//                     tool results / failures) -> keyword hits
//   hits           -> controller gates -> fire-and-forget `mnemon recall`
//   agent/pre-step -> queue is drained at the step boundary; the retrieval is
//                     never awaited, so the boundary cannot stall
//
// Hard rules (SPEC 5.6):
//   * apply() catches everything; a failure here must never stop `dsh web`.
//   * everything registered belongs to this plugin's fiber via ctx.effect /
//     ctx.on, so a stop or update removes it.
//   * no retrieval result is ever awaited on the critical path.
import process from 'node:process'
import { PLUGIN_NAME, PLUGIN_VERSION, resolveConfig } from './config.js'
import { createCardBuilder } from './cards.js'
import { createController } from './controller.js'
import { createLogger } from './log.js'
import { SEED_KEYWORDS } from './keywords.js'
import { createMemoryWatch } from './memory-watch.js'
import { createStoreReader, defaultStorePaths } from './mnemon-store.js'
import { createObserver } from './observer.js'
import { createRecall } from './recall.js'
import { createTermTable } from './table.js'
import { createVerifier } from './verify.js'
import { isRecallMessageSource } from './surface.js'

export const name = PLUGIN_NAME

/** No hard service dependency: `agents` is read optionally with ctx.get(). */
export const inject = []

/** Prefer the host timer service so timers die with this plugin's fiber. */
function resolveTimers(ctx) {
  try {
    const timer = ctx.get('timer')
    if (timer !== undefined && typeof timer.setTimeout === 'function' && typeof timer.clearTimeout === 'function') {
      return {
        setTimeout: (fn, ms) => timer.setTimeout(fn, ms),
        clearTimeout: (handle) => timer.clearTimeout(handle),
      }
    }
  } catch {
    // fall through to the globals the host process provides
  }
  return { setTimeout, clearTimeout }
}

export function apply(ctx, config = {}) {
  try {
    const resolved = resolveConfig(config)
    if (!resolved.enabled) return undefined

    const logger = createLogger({ path: resolved.logPath, maxBytes: resolved.logMaxBytes })
    const recall = createRecall({ config: resolved, logger })
    const verifier = createVerifier({ config: resolved, logger })
    // Resolved lazily: the table and the memory watch are created below, and these
    // are only ever read while a verdict / trigger is being logged.
    let documentFrequencyOf = null
    const controller = createController({
      config: resolved,
      logger,
      recall,
      verify: verifier,
      surfaceDistance,
      cardMeta: (term) => {
        const entry = table.entries.get(term)
        const df = documentFrequencyOf === null ? undefined : documentFrequencyOf().get(term)
        return {
          ...(typeof entry?.kind === 'string' ? { termKind: entry.kind } : {}),
          ...(typeof entry?.source === 'string' ? { source: entry.source } : {}),
          ...(typeof df === 'number' ? { df } : {}),
        }
      },
    })

    // The trigger vocabulary is the seed list plus whatever the memory store
    // currently holds; the watch keeps the derived half current.
    const table = createTermTable({ seedEntries: [...SEED_KEYWORDS, ...resolved.keywords], logger })
    const paths = defaultStorePaths(resolved)
    const store = createStoreReader({
      paths: {
        documentsRoot: resolved.mnemonDataDir,
        dbPath: resolved.storeDbPath === '' ? paths.dbPath : resolved.storeDbPath,
        documentsIndexPath: resolved.storeDocumentsIndexPath === '' ? paths.documentsIndexPath : resolved.storeDocumentsIndexPath,
      },
      limits: { insights: resolved.maxMemories, documents: resolved.maxMemories },
      logger,
    })
    const builder = createCardBuilder({ config: resolved, logger, cachePath: resolved.cardCachePath })
    const watch = createMemoryWatch({ table, store, builder, logger, config: resolved, timers: resolveTimers(ctx) })
    documentFrequencyOf = () => watch.documentFrequency()
    const observer = createObserver({
      logger,
      config: resolved,
      table: () => watch.table.current(),
      onHits: (hits, meta) => controller.handleHits(hits, meta),
    })
    const installed = new Map()
    /** Mount state for the status command: undefined = still waiting. */
    let promptNoteOk
    let commandOk

    observer.note('ready', {
      plugin: name,
      version: PLUGIN_VERSION,
      pid: process.pid,
      node: process.version,
      cwd: process.cwd(),
      logPath: resolved.logPath,
      terms: table.stats().terms,
      stage: 'P3-live-vocabulary',
      retrieval: {
        cliConfigured: recall.cliPath !== '',
        timeoutMs: resolved.recallTimeoutMs,
        limit: resolved.recallLimit,
        minScore: resolved.minScore,
        cooldownMs: resolved.cooldownMs,
        cacheMs: resolved.recallCacheMs,
      },
      injection: {
        maxPerTurn: resolved.maxInjectionsPerTurn,
        maxCards: resolved.maxCardsPerInjection,
        maxBytes: resolved.maxInjectBytes,
      },
      vocabulary: {
        cardBuilder: builder.mode,
        localModel: builder.mode === 'local' ? resolved.localModel : '',
        cardChars: resolved.cardChars,
        cardCachePath: resolved.cardCachePath,
        reconcileDebounceMs: resolved.reconcileDebounceMs,
        reconcileMs: resolved.reconcileMs,
        storeDbPath: resolved.storeDbPath === '' ? paths.dbPath : resolved.storeDbPath,
      },
      gate: {
        verifyEnabled: verifier.enabled,
        verifyTimeoutMs: resolved.verifyTimeoutMs,
        verifyContextChars: resolved.verifyContextChars,
        // Evidence for the boot-storm fix (DEV_NOTES 4.12): a cold load must get a
        // budget long enough to finish, or the abort cancels the load it waits for.
        verifyRetryTimeoutMs: resolved.verifyRetryTimeoutMs,
        verifyRetryLimit: resolved.verifyRetryLimit,
        warmupAttempts: resolved.warmupAttempts,
        verifyBackoffMaxMs: resolved.verifyBackoffMaxMs,
        checkerPath: verifier.checkerPath,
      },
      // Evidence for the post-restart check: these three are the changes that only
      // take effect after `dsh web` restarts (card-source logging, score recording,
      // unreadable-window reporting).
      observability: {
        cardSourceLogging: true,
        scoreLogLimit: resolved.scoreLogLimit,
        unreadableReporting: true,
      },
    })

    // Build/refresh the vocabulary in the background: the seed list already
    // works, so startup is never blocked by 200+ local model calls.
    void watch.reconcile('startup')

    if (resolved.warmupOnStart && recall.cliPath !== '') {
      void recall
        .warmup()
        .then((result) => observer.note('warmup', { rows: result.rows?.length ?? 0, ms: result.ms, error: result.error }))
        .catch((error) => observer.note('warmup', { error: String(error?.message ?? error) }))
    }

    // The judge costs ~5 s on a cold model, so it is warmed once at startup.
    if (resolved.verifyEnabled) {
      void verifier
        .warmup()
        .then((verdict) => observer.note('verify-warmup', { ok: verdict.inconclusive !== true, ms: verdict.ms, why: verdict.why }))
        .catch((error) => observer.note('verify-warmup', { error: String(error?.message ?? error) }))
    }

    /**
     * token-meter gives the "too far" criterion (SPEC 5.4.2): an injection that is
     * still in the surface but tens of thousands of tokens behind the tail no
     * longer influences the model, so it may be re-injected. Same lesson as the
     * commands service: wait for the service instead of one-shot ctx.get.
     */
    let meter
    let stopMeterInject
    if (typeof ctx.inject === 'function') {
      try {
        stopMeterInject = ctx.inject(['tokenMeter'], (scoped) => {
          meter = scoped.tokenMeter
          observer.note('token-meter', { via: 'inject' })
        })
      } catch (error) {
        observer.note('token-meter', { error: String(error?.message ?? error) })
      }
    }

    function surfaceDistance(sessionRef, messageId) {
      try {
        if (meter === undefined || sessionRef === undefined) return undefined
        const nodes = sessionRef.surface?.nodes
        if (!Array.isArray(nodes) || typeof sessionRef.eventAt !== 'function') return undefined
        let targetSeq
        for (const seq of nodes) {
          const event = sessionRef.eventAt(seq)
          if (event?.type !== 'user/message') continue
          const source = event.data?.source
          if (isRecallMessageSource(source) && event.data.id === messageId) {
            targetSeq = seq
            break
          }
        }
        if (targetSeq === undefined) return undefined
        const measurement = meter.measure(sessionRef)
        const tokenNodes = measurement?.nodes
        if (!Array.isArray(tokenNodes)) return undefined
        let sum = 0
        let after = false
        for (const node of tokenNodes) {
          if (node.seq === targetSeq) {
            after = true
            continue
          }
          if (after) sum += Number(node.tokens) || 0
        }
        return after ? sum : undefined
      } catch {
        return undefined
      }
    }

    // Constant system-prompt note (SPEC 5.5). The text never varies, so the
    // provider's cached prefix stays valid after the first request.
    const SYSTEM_NOTE = [
      '【经验召回】本会话装有跨项目经验召回。当你的思考、工具参数或报错命中记忆库里的关键词时，',
      '系统会在下一步开始前插入一条形如「【可能相关的历史经验 · 来自其他项目】」的消息，每条带（记忆 id: …）。',
      '那是有用的旧经验，不是用户说的话；需要细节用 mnemon_recall / document_search 取全文。',
    ].join('')
    let stopPromptNote
    let stopPromptNoteInject
    if (resolved.systemPromptNote) {
      const registerNote = (service) => {
        if (service === undefined || typeof service.section !== 'function') {
          promptNoteOk = false
          return
        }
        stopPromptNote = service.section({ name: 'experience-recall', order: 900, text: SYSTEM_NOTE })
        promptNoteOk = true
        observer.note('system-prompt-section', { name: 'experience-recall', chars: SYSTEM_NOTE.length })
      }
      try {
        const service = ctx.get('systemPrompt')
        if (service !== undefined && typeof service.section === 'function') {
          registerNote(service)
        } else if (typeof ctx.inject === 'function') {
          stopPromptNoteInject = ctx.inject(['systemPrompt'], (scoped) => {
            try {
              registerNote(scoped.systemPrompt)
            } catch (error) {
              promptNoteOk = false
              observer.note('system-prompt-section', { error: String(error?.message ?? error) })
            }
          })
          observer.note('system-prompt-section', { pending: true })
        } else {
          promptNoteOk = false
        }
      } catch (error) {
        promptNoteOk = false
        observer.note('system-prompt-section', { error: String(error?.message ?? error) })
      }
    }

    function install(agent) {
      const disposers = []
      try {
        const agentId = typeof agent?.id === 'string' ? agent.id : undefined
        if (agentId === undefined || installed.has(agentId)) return
        const scoped = agent.ctx
        if (scoped === undefined || typeof scoped.on !== 'function') return
        let sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : agentId
        const subscribe = (event, handler) => disposers.push(scoped.on(event, handler))
        subscribe('session/event', (session, event) => {
            const liveSessionId = typeof session?.id === 'string' ? session.id : sessionId
            const type = typeof event?.type === 'string' ? event.type : ''
            if (type === 'compaction/summary' || type === 'compaction/prune') controller.invalidate(liveSessionId, type)
            // Memory-tool traffic drives the incremental vocabulary refresh.
            watch.observe(event, liveSessionId)
            // The same tool call repeated in a short window means the model is
            // going in circles — the moment a past experience helps most.
            if (type === 'tool/call' && event.data !== null && typeof event.data === 'object') {
              controller.noteToolCall({
                sessionId: liveSessionId,
                name: event.data.name,
                arguments: event.data.arguments,
                turn: event.data.turn,
                step: event.data.step,
                sessionRef: session,
              })
            }
            observer.observe(event, { agentId, sessionId: liveSessionId, sessionRef: session })
          })
          subscribe('agent/session-start', (payload) => {
            controller.reset(sessionId, 'session-start')
            sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : agentId
            controller.reset(sessionId, 'session-start')
            observer.note('session-start', {
              agentId,
              sessionId,
              source: typeof payload?.source === 'string' ? payload.source : undefined,
            })
          })
          subscribe('agent/pre-step', async (payload, next) => {
            sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : agentId
            const boundarySessionId = sessionId
            observer.observePreStep(payload, { agentId, sessionId })
            // Semantic fallback is decided at the boundary (step boundaries are
            // where "every N steps" is meaningful); it is fire-and-forget, so the
            // decision below is unaffected.
            controller.maybeSemanticFallback({ sessionRef: agent?.session, sessionId, turn: payload?.turn, step: payload?.step })
            const decision = await next()
            try {
              if (decision?.kind !== 'enter' || payload?.signal?.aborted || agent?.session?.id !== boundarySessionId || !Array.isArray(decision.messages)) return decision
              // Boundary rule: take what is ready, never wait for retrieval.
              const message = controller.takeMessage({
                agent,
                sessionRef: agent?.session,
                agentId,
                sessionId,
                turn: payload?.turn,
                step: payload?.step,
              })
              if (message === undefined) return decision
              return { ...decision, messages: [...decision.messages, message] }
            } catch (error) {
              console.error(`[${PLUGIN_NAME}] injection failed:`, error)
              return decision
            }
          })
        installed.set(agentId, () => {
          for (const dispose of [...disposers].reverse()) {
            try {
              dispose?.()
            } catch (error) {
              console.error(`[${PLUGIN_NAME}] dispose failed:`, error)
            }
          }
        })
        observer.note('agent-installed', { agentId, sessionId })
      } catch (error) {
        for (const dispose of disposers.reverse()) {
          try { dispose?.() } catch { /* best effort rollback */ }
        }
        console.error(`[${PLUGIN_NAME}] install failed:`, error)
      }
    }

    /**
     * Human-readable status for the resident form, where there is no Run card:
     * a `/experience-recall` slash command prints exactly the same numbers the
     * dynamic Package exposes through `experience_recall_status`.
     */
    function statusText() {
      const control = controller.snapshot()
      const verify = verifier.stats()
      const retrieve = recall.stats()
      const vocab = watch.snapshot()
      const observed = observer.snapshot()
      const lines = [
        `经验召回 · 常驻插件（${PLUGIN_VERSION}）`,
        `词表 ${vocab.table?.terms ?? 0} 条（记忆 ${vocab.memories} / 文档 ${vocab.documents}） | 被 ubiquity 过滤 ${vocab.blockedTerms ?? 0} 词 | 卡片缓存 ${resolved.cardCachePath}`,
        `扫描事件 ${observed.events} | 分段 ${observed.segments} | 字符 ${observed.chars} | 关键词命中 ${observed.hits}`,
        `候选：索引直出 ${control.direct}，CLI 检索 ${control.recalls}，语义兜底 ${control.semantic}（含重复摸索 ${control.repeatTriggers}），入队 ${control.queued}`,
        `小模型判定：通过 ${control.accepted}，拒绝 ${control.rejected}，不确定 ${control.inconclusive}，跳过（未启用）${control.verifySkipped} | 均 ${verify.avgMs} ms（${verify.calls} 次，重试 ${verify.retries ?? 0}，限流等待 ${verify.waitedMs} ms，退避 ${verify.backoffMs ?? 0} ms）`,
        `判定通过来源 ${sourceBreakdown(control.bySource)} | 判定器报告"窗口不可读" ${verify.unreadable ?? 0} 次（仅记录，不拦）`,
        `长会话判据：远距重插 ${control.reinjectFar} 次（阈值 ${resolved.reinjectTokenDistance} token） | 词条冷却 ${control.termCooldowns} 个${control.cooledTerms?.length ? `：${control.cooledTerms.join(' ')}` : ''}`,
        `注入 ${control.injected} 次 / ${control.cards} 张 / ${control.bytes} B | 检索 ${retrieve.calls} 次（缓存命中 ${retrieve.cacheHits}，超时 ${retrieve.timedOut}）`,
        `最近通过：${control.lastAccepted || '（无）'}`,
        `挂载：系统提示段 ${promptNoteState()} | 命令 /experience-recall ${commandState()} | token-meter ${meter === undefined ? '未接入' : '已接入'}`,
        `索引：${stats0(vocab)} | 文档切片 ${(vocab.builder?.fragments ?? 0)} 条 | 异常 ${control.failures + observed.failures}`,
        `最近跳过 ${Object.entries(control.skipped ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, value]) => `${key}=${value}`).join(' ') || '—'}`,
        `日志：${resolved.logPath}`,
      ]
      return lines.join('\n')
    }

    function promptNoteState() {
      if (promptNoteOk === true) return '已注册'
      if (promptNoteOk === false) return '注册失败'
      return resolved.systemPromptNote ? '等待服务' : '已关闭'
    }

    function commandState() {
      if (commandOk === true) return '已注册'
      if (commandOk === false) return '注册失败'
      return '等待服务'
    }

    /** "记忆模型卡 12 / 切片卡 2 / 文档卡 1" — which half of the vocabulary earns its keep. */
    function sourceBreakdown(bySource) {
      const entries = Object.entries(bySource ?? {})
      if (entries.length === 0) return '（暂无）'
      return entries
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => `${key} ${value}`)
        .join(' / ')
    }

    function stats0(vocab) {      const builder = vocab.builder ?? {}
      return `缓存命中 ${builder.cacheHits ?? 0} / 模型 ${builder.model ?? 0} / 回退 ${builder.mechanical ?? 0} / 文档 ${builder.documents ?? 0}`
    }

    return ctx.effect(() => {
      let stopCreated
      try {
        stopCreated = ctx.on('agent/created', ({ agent }) => install(agent))
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] agent/created subscribe failed:`, error)
      }
      try {
        const agents = ctx.get('agents')
        if (agents !== undefined && typeof agents.roots === 'function') {
          for (const agent of agents.roots()) install(agent)
        }
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] adopting existing agents failed:`, error)
      }
      // The `/experience-recall` status command. Measured failure mode: a
      // one-shot `ctx.get('commands')` check silently skipped registration
      // because the service was not published yet when this bundle applied
      // (verified by a probe: `commands.register` itself works fine and a probe
      // command showed up immediately). So: register now if possible, otherwise
      // wait for the service, and log the outcome either way.
      let stopCommand
      let stopCommandInject
      const registerCommand = (commands) => {
        const handle = commands.register({
          name: 'experience-recall',
          description: '查看「经验召回」插件的运行状态：词表规模、关键词命中、小模型判定通过/拒绝、注入次数、最近通过的那条记忆',
          handler: () => ({ kind: 'success', text: statusText() }),
        })
        commandOk = true
        return handle
      }
      try {
        const commands = ctx.get('commands')
        if (commands !== undefined && typeof commands.register === 'function') {
          stopCommand = registerCommand(commands)
          observer.note('command-registered', { name: 'experience-recall', via: 'direct' })
        } else if (typeof ctx.inject === 'function') {
          stopCommandInject = ctx.inject(['commands'], (scoped) => {
            try {
              stopCommand = registerCommand(scoped.commands)
              observer.note('command-registered', { name: 'experience-recall', via: 'inject' })
            } catch (error) {
              commandOk = false
              observer.note('command-failed', { stage: 'inject', error: String(error?.message ?? error) })
            }
          })
          observer.note('command-pending', { reason: 'commands service not published yet; waiting' })
        } else {
          commandOk = false
          observer.note('command-skipped', { reason: 'no commands service and no ctx.inject' })
        }
      } catch (error) {
        commandOk = false
        observer.note('command-failed', { stage: 'direct', error: String(error?.message ?? error) })
        console.error(`[${PLUGIN_NAME}] command registration failed:`, error)
      }
      return () => {
        try {
          stopCreated?.()
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] unsubscribe failed:`, error)
        }
        try {
          // ctx.inject returns the child fiber (thenable, with dispose), not a
          // disposer function; it also dies with this fiber.
          if (typeof stopCommandInject === 'function') stopCommandInject()
          else stopCommandInject?.dispose?.()
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] command inject dispose failed:`, error)
        }
        try {
          stopCommand?.()
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] command dispose failed:`, error)
        }
        for (const [label, handle] of [['meter', stopMeterInject], ['prompt-note', stopPromptNoteInject]]) {
          try {
            if (typeof handle === 'function') handle()
            else handle?.dispose?.()
          } catch (error) {
            console.error(`[${PLUGIN_NAME}] ${label} inject dispose failed:`, error)
          }
        }
        try {
          stopPromptNote?.()
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] prompt section dispose failed:`, error)
        }
        for (const dispose of [...installed.values()].reverse()) {
          try {
            dispose()
          } catch (error) {
            console.error(`[${PLUGIN_NAME}] agent dispose failed:`, error)
          }
        }
        installed.clear()
        controller.dispose()
        watch.dispose()
        observer.note('stopped', {
          agents: installed.size,
          controller: controller.snapshot(),
          retrieval: recall.stats(),
          verification: verifier.stats(),
          vocabulary: watch.snapshot(),
        })
        void observer.flush()
      }
    }, 'dsh-experience-recall: lifecycle')
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] apply failed:`, error)
    return undefined
  }
}
