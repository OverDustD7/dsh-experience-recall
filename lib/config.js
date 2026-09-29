// Configuration resolution for dsh-experience-recall.
// The loader hands the cordis row's `config` to apply(ctx, config); everything
// here is plain data so the module stays testable outside the host.
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = 'dsh-experience-recall'
export const PLUGIN_VERSION = '0.7.2'
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where this plugin keeps state (observation log, card cache).
 *
 * Publishing made this matter: relative defaults used to resolve against the
 * plugin root, which for an installed package is inside `node_modules` — a
 * reinstall or upgrade would silently throw the log and the ~6-minute card cache
 * away. The DSH convention is to keep state under the harness home, so the
 * default is `<DSH_HOME|~/.dsh>/dsh-experience-recall`. A repo checkout overrides
 * it (see the profile patch) to keep the log and cache beside the code.
 */
export function defaultStateDir() {
  const home = String(process.env.DSH_HOME ?? '').trim()
  const base = home === '' ? join(homedir(), '.dsh') : expandHome(home)
  return join(base, 'dsh-experience-recall')
}

export const DEFAULT_CONFIG = {
  /** Master switch. When false the plugin registers nothing at all. */
  enabled: true,
  /** Directory for state. Empty means `defaultStateDir()`. */
  stateDir: '',
  /** NDJSON observation log. Absolute wins; a relative path resolves against the plugin root. */
  logPath: '',
  /** Rotate to `<logPath>.1` once the file would exceed this many bytes. */
  logMaxBytes: 32 * 1024 * 1024,
  /** Emit a `stats` record every N observed events. */
  statsEvery: 200,
  /** Characters of context captured around each keyword hit. */
  contextChars: 60,
  /** Upper bound on the text scanned per segment (defends against huge tool results). */
  maxSegmentChars: 200000,
  /** Extra trigger terms appended to the built-in seed table. */
  keywords: [],

  // ---- retrieval (tier 3: mnemon CLI) -------------------------------------
  /** Executable to run. Defaults to $MNEMON_CLI_PATH. */
  mnemonCliPath: '',
  /** Extra leading arguments (e.g. a wrapper script) inserted before `recall`. */
  mnemonCliArgs: [],
  /** Mnemon home. `~` expands to the current user's home directory. */
  mnemonDataDir: '~/.dsh/mnemon',
  mnemonStore: 'default',
  mnemonEmbedEndpoint: 'http://localhost:11434',
  mnemonEmbedModel: 'bge-m3',
  mnemonEmbedProtocol: 'ollama',
  /** Candidates requested from the CLI per query. */
  recallLimit: 3,
  /** Hard timeout for one CLI call. Cold bge-m3 measured at ~2.8 s. */
  recallTimeoutMs: 5000,
  /** Repeated identical queries within this window reuse the cached result. */
  recallCacheMs: 10 * 60 * 1000,
  /** Drop candidates scoring below this (mnemon's own low threshold is 0.25). */
  minScore: 0.35,
  /** One recall per trigger term at most this often. */
  cooldownMs: 60000,
  /** Warm bge-m3 once at startup so the first real recall is not cold. */
  warmupOnStart: true,

  // ---- injection ----------------------------------------------------------
  /** Hard cap: injections per turn (SPEC 5.4). */
  maxInjectionsPerTurn: 3,
  /** Cards inside one injection. */
  maxCardsPerInjection: 2,
  /** Hard byte cap for one injection block (SPEC: <= 400 token). */
  maxInjectBytes: 1200,

  // ---- semantic fallback (SPEC 5.2, auxiliary path) -----------------------
  /** When false, only keyword hits trigger retrieval. */
  semanticFallback: true,
  /** Retrieve with the recent text itself every N steps. */
  semanticEverySteps: 5,
  /** Minimum characters of recent text before a semantic query is worth it. */
  semanticMinChars: 60,
  /** Floor between two semantic retrievals in one session. */
  semanticCooldownMs: 120000,

  // ---- vocabulary: derived from memory, kept current ----------------------
  /**
   * `local` = build cards/terms with the local Ollama model and fall back to
   * mechanical extraction; anything else = mechanical only.
   */
  cardBuilder: 'local',
  localModel: 'qwen3.5:9b',
  /**
   * Model that builds cards and judges their scope. Card building runs offline in
   * the reconcile path, so a slower, better model is affordable here while the
   * in-session judge stays on `localModel`. Empty = use `localModel`.
   */
  cardModel: '',
  localEndpoint: 'http://localhost:11434',
  localTimeoutMs: 60000,
  localNumCtx: 8192,
  /** Card budget in characters (measured: the model overshoots if unenforced). */
  cardChars: 150,
  /** Persisted card cache. Absolute wins; relative resolves against the plugin root. */
  cardCachePath: '',
  /** Upper bound on memories/documents read from the store per reconcile. */
  maxMemories: 5000,
  /** Mnemon home for the store reader. */
  storeDbPath: '',
  storeDocumentsIndexPath: '',
  /** After a `mnemon_*` tool call, wait this long before diffing the store. */
  reconcileDebounceMs: 1500,
  /** Safety net for writes that bypass the memory tools. */
  reconcileMs: 300000,
  /** Ubiquity filter: a term carried by more than this share of all cards cannot
   * discriminate between memories, so it never enters the trigger table. */
  maxTermDocumentFrequency: 0.02,
  /** Floor for the same filter: on a small corpus 2% rounds down to nothing. */
  ubiquityFloor: 4,

  // ---- second-stage gate: local model relevance judgement ------------------
  /** When false, mechanical hits are injected without a judgement. */
  verifyEnabled: true,
  /** Judgement budget (warm ~0.3 s; the first call after an unload ~5 s). */
  verifyTimeoutMs: 6000,
  /**
   * One retry with a longer budget when the model never answered at all.
   * Ollama cancels a model load when its client disconnects, so retrying inside
   * the normal budget cancels the very load it is waiting for (a livelock that
   * produced 52 aborted loads on 2026-09-16). Capped at 5x `verifyTimeoutMs`.
   */
  verifyRetryTimeoutMs: 30000,
  /** How many such longer retries one judgement may make (0 disables). */
  verifyRetryLimit: 1,
  /** Warmup attempts while the model is still loading. */
  warmupAttempts: 3,
  /** Gap between warmup attempts. */
  warmupRetryDelayMs: 5000,
  /** After an inconclusive judgement the next start waits base * 2^(streak-1). */
  verifyBackoffBaseMs: 2000,
  /** Ceiling for that backoff. */
  verifyBackoffMaxMs: 30000,
  /** Characters of recent session text handed to the judge as context. */
  verifyContextChars: 700,
  /** Node used to run the checker (defaults to the host's own executable). */
  nodePath: '',
  /** Floor between two judgement starts (bounds continuous local GPU load). */
  verifyMinIntervalMs: 1200,
  /** A term rejected this many times without ever being accepted is cooled down. */
  termRejectLimit: 3,
  termBlockCooldownMs: 1800000,
  /** Retrieved rows per recall to record (scores only) for `minScore` calibration. */
  scoreLogLimit: 5,

  // ---- long-session criteria (SPEC 5.4.2) ---------------------------------
  /** Tokens between an injection and the tail beyond which it is forgotten. */
  reinjectTokenDistance: 20000,
  /** Same tool call repeated this many times in the window means "going in circles". */
  repeatToolLimit: 3,
  repeatWindowSteps: 12,

  // ---- constant system-prompt note (SPEC 5.5) -----------------------------
  /** Register a CONSTANT explanation section (never varies, so the cached
   * prefix stays valid). */
  systemPromptNote: true,

  // ---- tier 2: document fragments (SPEC 5.2.4) ----------------------------
  /** Index `##` sections of each project document, not just title+description. */
  documentFragments: true,
  /** Card budget for one fragment. */
  fragmentChars: 200,
}

function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function expandHome(value) {
  const text = String(value ?? '')
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...source }
  // State defaults to the harness home; a configured relative path still resolves
  // against the plugin root (repo checkouts keep their log/cache beside the code).
  const stateDir = typeof merged.stateDir === 'string' && merged.stateDir.trim() !== '' ? resolve(expandHome(merged.stateDir.trim())) : defaultStateDir()
  const configuredLog = typeof merged.logPath === 'string' ? merged.logPath.trim() : ''
  const logPath = configuredLog === '' ? join(stateDir, 'logs', 'observe.ndjson') : configuredLog
  // An explicitly configured path wins, including an explicit empty string that
  // disables retrieval; only an absent key falls back to the environment.
  const explicitCliPath = Object.prototype.hasOwnProperty.call(source, 'mnemonCliPath')
  const cliPath = explicitCliPath
    ? String(merged.mnemonCliPath ?? '').trim()
    : String(process.env.MNEMON_CLI_PATH ?? '').trim()
  return {
    ...merged,
    stateDir,
    enabled: merged.enabled !== false,
    logPath: isAbsolute(logPath) ? logPath : resolve(PLUGIN_ROOT, logPath),
    logMaxBytes: positiveInteger(merged.logMaxBytes, DEFAULT_CONFIG.logMaxBytes),
    statsEvery: positiveInteger(merged.statsEvery, DEFAULT_CONFIG.statsEvery),
    contextChars: positiveInteger(merged.contextChars, DEFAULT_CONFIG.contextChars),
    maxSegmentChars: positiveInteger(merged.maxSegmentChars, DEFAULT_CONFIG.maxSegmentChars),
    keywords: Array.isArray(merged.keywords) ? merged.keywords : [],

    mnemonCliPath: cliPath,
    mnemonCliArgs: Array.isArray(merged.mnemonCliArgs) ? merged.mnemonCliArgs.map(String) : [],
    mnemonDataDir: resolve(expandHome(source.mnemonDataDir ?? process.env.MNEMON_DATA_DIR ?? join(dirname(defaultStateDir()), 'mnemon'))),
    mnemonStore: String(source.mnemonStore ?? process.env.MNEMON_STORE ?? DEFAULT_CONFIG.mnemonStore),
    mnemonEmbedEndpoint: String(merged.mnemonEmbedEndpoint ?? DEFAULT_CONFIG.mnemonEmbedEndpoint),
    mnemonEmbedModel: String(merged.mnemonEmbedModel ?? DEFAULT_CONFIG.mnemonEmbedModel),
    mnemonEmbedProtocol: String(merged.mnemonEmbedProtocol ?? DEFAULT_CONFIG.mnemonEmbedProtocol),
    recallLimit: positiveInteger(merged.recallLimit, DEFAULT_CONFIG.recallLimit),
    recallTimeoutMs: positiveInteger(merged.recallTimeoutMs, DEFAULT_CONFIG.recallTimeoutMs),
    recallCacheMs: positiveInteger(merged.recallCacheMs, DEFAULT_CONFIG.recallCacheMs),
    minScore: positiveNumber(merged.minScore, DEFAULT_CONFIG.minScore),
    cooldownMs: positiveInteger(merged.cooldownMs, DEFAULT_CONFIG.cooldownMs),

    maxInjectionsPerTurn: positiveInteger(merged.maxInjectionsPerTurn, DEFAULT_CONFIG.maxInjectionsPerTurn),
    maxCardsPerInjection: Math.max(1, positiveInteger(merged.maxCardsPerInjection, DEFAULT_CONFIG.maxCardsPerInjection)),
    maxInjectBytes: positiveInteger(merged.maxInjectBytes, DEFAULT_CONFIG.maxInjectBytes),

    cardBuilder: merged.cardBuilder === 'local' ? 'local' : 'mechanical',
    localModel: String(merged.localModel ?? DEFAULT_CONFIG.localModel).trim(),
    localEndpoint: String(merged.localEndpoint ?? DEFAULT_CONFIG.localEndpoint).trim(),
    localTimeoutMs: positiveInteger(merged.localTimeoutMs, DEFAULT_CONFIG.localTimeoutMs),
    localNumCtx: positiveInteger(merged.localNumCtx, DEFAULT_CONFIG.localNumCtx),
    cardChars: Math.max(40, positiveInteger(merged.cardChars, DEFAULT_CONFIG.cardChars)),
    cardCachePath: (() => {
      const explicit = Object.prototype.hasOwnProperty.call(source, 'cardCachePath')
      const value = typeof merged.cardCachePath === 'string' ? merged.cardCachePath.trim() : ''
      // An explicit empty string still means "no cache" (rebuild every start).
      if (explicit && value === '') return ''
      const path = value === '' ? join(stateDir, 'cache', 'cards.json') : value
      return isAbsolute(path) ? path : resolve(PLUGIN_ROOT, path)
    })(),
    maxMemories: positiveInteger(merged.maxMemories, DEFAULT_CONFIG.maxMemories),
    storeDbPath: merged.storeDbPath === '' ? '' : resolve(expandHome(merged.storeDbPath)),
    storeDocumentsIndexPath: merged.storeDocumentsIndexPath === '' ? '' : resolve(expandHome(merged.storeDocumentsIndexPath)),
    reconcileDebounceMs: positiveInteger(merged.reconcileDebounceMs, DEFAULT_CONFIG.reconcileDebounceMs),
    reconcileMs: positiveInteger(merged.reconcileMs, DEFAULT_CONFIG.reconcileMs),
    maxTermDocumentFrequency: positiveNumber(merged.maxTermDocumentFrequency, DEFAULT_CONFIG.maxTermDocumentFrequency),
    ubiquityFloor: Math.max(2, positiveInteger(merged.ubiquityFloor, DEFAULT_CONFIG.ubiquityFloor)),

    verifyEnabled: merged.verifyEnabled !== false,
    verifyTimeoutMs: positiveInteger(merged.verifyTimeoutMs, DEFAULT_CONFIG.verifyTimeoutMs),
    verifyContextChars: Math.max(100, positiveInteger(merged.verifyContextChars, DEFAULT_CONFIG.verifyContextChars)),
    nodePath: String(merged.nodePath ?? DEFAULT_CONFIG.nodePath).trim(),

    semanticFallback: merged.semanticFallback !== false,
    semanticEverySteps: Math.max(1, positiveInteger(merged.semanticEverySteps, DEFAULT_CONFIG.semanticEverySteps)),
    semanticMinChars: Math.max(10, positiveInteger(merged.semanticMinChars, DEFAULT_CONFIG.semanticMinChars)),
    semanticCooldownMs: positiveInteger(merged.semanticCooldownMs, DEFAULT_CONFIG.semanticCooldownMs),

    verifyMinIntervalMs: positiveInteger(merged.verifyMinIntervalMs, DEFAULT_CONFIG.verifyMinIntervalMs),
    termRejectLimit: Math.max(1, positiveInteger(merged.termRejectLimit, DEFAULT_CONFIG.termRejectLimit)),
    termBlockCooldownMs: positiveInteger(merged.termBlockCooldownMs, DEFAULT_CONFIG.termBlockCooldownMs),
    scoreLogLimit: positiveInteger(merged.scoreLogLimit, DEFAULT_CONFIG.scoreLogLimit),
    reinjectTokenDistance: positiveInteger(merged.reinjectTokenDistance, DEFAULT_CONFIG.reinjectTokenDistance),
    repeatToolLimit: Math.max(2, positiveInteger(merged.repeatToolLimit, DEFAULT_CONFIG.repeatToolLimit)),
    repeatWindowSteps: Math.max(1, positiveInteger(merged.repeatWindowSteps, DEFAULT_CONFIG.repeatWindowSteps)),
    systemPromptNote: merged.systemPromptNote !== false,
    documentFragments: merged.documentFragments !== false,
    fragmentChars: Math.max(60, positiveInteger(merged.fragmentChars, DEFAULT_CONFIG.fragmentChars)),
  }
}
