# dsh-experience-recall

[中文](README.zh.md) ｜ DeepSeek Harness plugin (profile bundle)

[![npm](https://img.shields.io/npm/v/dsh-experience-recall)](https://www.npmjs.com/package/dsh-experience-recall)
[![ci](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.5-informational)](https://nodejs.org)

**Your agent forgets what it learned in other projects. This plugin hands it back at the right moment.**

It watches what the model is doing — its reasoning, its tool calls, its failures — and when the running
work matches something your memory store already learned somewhere else, it injects that one lesson as a
short message right before the next step. Everything runs locally: the keyword table, the retrieval and
the relevance judge use your own machine by default. Injected messages still consume the host model's
context and input tokens.

## What it looks like

A real injection from a DSH session (trimmed):

```
【可能相关的历史经验 · 来自其他项目】
· 验证自研 DSH 宿主插件的一次性宿主法（不必重启 GUI、不碰 ~/.dsh）：把 DSH_HOME 指到 %TEMP% 里的临时 home，
  拷入 settings.yaml 与 .credentials.yaml，profile 的 dsh.profile.bundles 只写 [dsh-base, dsh-headless, 自研插件]，
  然后用 dsh --profile …（记忆 id: 0f5eddca）

需要细节：用 mnemon_recall / document_search 取全文。
```

The card is deliberately one line with the reusable conclusion, plus an id so the model can pull the full
memory if it needs it. At most a few of these per turn, ~1.2 KB each.

## How it works

```
session/event (reasoning · text · tool arguments · tool results · errors)
  → mechanical keyword match against a vocabulary derived from your memories   (free, no model)
  → gates: once per term per turn · once per memory · cooldown · per-turn quota
  → local small model judges "does this lesson change what I should do next?"  (serialized, ~0.4 s)
  → the ready result is appended at the next agent/pre-step boundary
```

The boundary **never waits**: if retrieval or judging is not finished when the next step starts, that step
simply proceeds and the card arrives a step later. Nothing is injected on a guess — an unparsable or
uncertain judgement is dropped rather than shown.

The vocabulary is not hand-written. It is derived from your memory store (author tags/entities plus the
proper nouns in the text) and from your project documents, including each document's `##` sections, then
filtered for terms that cannot discriminate anything. New memories are picked up automatically after a
`mnemon_*` tool call.

## Requirements

| Need | Why | Without it |
|---|---|---|
| DSH `>= 0.1.5-rc.1` | host | — |
| Node `>= 22.5`, 24.x recommended | `node:sqlite` reads the memory store. On Node 22 that module needs `--experimental-sqlite`; it is unflagged from Node 23.4 | the plugin still runs, but the memory-derived vocabulary is empty (documents and seed terms keep working) |
| [dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) + the `mnemon` CLI | memory indexing and semantic search | without the CLI, already indexed cards can still trigger; CLI search is unavailable |
| A local model on Ollama (`http://localhost:11434`, default `qwen3.5:9b`) | builds the cards and judges relevance | it observes and logs, but **injects nothing** — it refuses to guess |

**Host compatibility.** An injected message carries a DSH v4 producer-owned source
(`kind: "plugin:dsh-experience-recall"`, the same kind the host's own v3→v4 migration derives for a
third-party plugin). Reading also recognises the pre-v4 `{ kind: "plugin", plugin }` wrapper, so
injections recorded by a 0.6.x / 0.7.0 session are still treated as plugin messages — for
visibility, de-duplication, the re-injection distance and the window scan — and never as user input.

## Install

```sh
dsh plugin --profile web add dsh-experience-recall
```

`web` is the profile behind the DSH web UI — substitute your own profile name if you renamed it. The
command forwards to your package manager, so it also accepts a repository or a local checkout:

```sh
# track this repository instead of the npm release
dsh plugin --profile web add github:OverDustD7/dsh-experience-recall

# development: install the checkout you are working in
dsh plugin --profile web add link:/path/to/dsh-experience-recall
```

Then restart `dsh web`. Installing already adds the package to the profile's `dsh.profile.bundles` — do
not add it by hand as well, or the loader fails with `duplicate loader entry id`.

## Verify it works

- In chat: **`/experience-recall`** prints the vocabulary size, scan/hit counters, how many candidates the
  judge accepted, rejected or never answered (with average latency and retry count), injections, and the
  last card that got through.
- On disk: `$DSH_HOME/dsh-experience-recall/logs/observe.ndjson` records `trigger` / `recall` (with the
  judge's reason) / `verify` / `inject` / `term-cooldown` — "why did it inject / why didn't it" is always
  answerable. Verdict records also carry which half of the vocabulary fired (`source`/`termKind`) and how
  common that term is.
- Install self-check: `node node_modules/dsh-experience-recall/tools/check-install.mjs` (add `--cache` /
  `--log` if you moved the state directory).

Give it a few minutes of real work first: on a fresh install the first start builds one card per memory
with the local model (a few hundred memories ≈ 5 minutes), and the vocabulary is thin until that finishes.

## Configuration

Everything is optional and lives in the row's `config` — either in the package's `cordis.patch.yml` or,
better, in your own profile patch (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), which wins:

```yaml
- id: experience-recall
  config:
    maxInjectionsPerTurn: 0     # keep observing, inject nothing
    localModel: 'qwen3.5:9b'
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `stateDir` | `$DSH_HOME/dsh-experience-recall` | where the log and the card cache live |
| `logPath` / `cardCachePath` | under `stateDir` | override individually; `cardCachePath: ''` disables the cache |
| `mnemonCliPath` | `$MNEMON_CLI_PATH` | the `mnemon` CLI; `''` disables CLI retrieval only |
| `mnemonDataDir` / `mnemonStore` | `$MNEMON_DATA_DIR` or `$DSH_HOME/mnemon` / `$MNEMON_STORE` or `default` | shared by the index reader and the CLI; unset `DSH_HOME` uses `~/.dsh` |
| `localModel` / `localEndpoint` | `qwen3.5:9b` / `http://localhost:11434` | card builder + relevance judge |
| `cardBuilder` | `local` | `mechanical` skips the model when building cards |
| `minScore` | `0.35` | retrieval score floor |
| `maxInjectionsPerTurn` / `maxCardsPerInjection` / `maxInjectBytes` | `3` / `2` / `1200` | injection budget |
| `verifyEnabled` / `verifyTimeoutMs` / `verifyMinIntervalMs` | `true` / `6000` / `1200` | the relevance gate |
| `verifyRetryTimeoutMs` / `verifyRetryLimit` | `30000` / `1` | one retry with a longer budget when the local model never answered — aborting a cold load cancels it in Ollama, so retrying inside the same budget livelocks that load |
| `verifyBackoffBaseMs` / `verifyBackoffMaxMs` | `2000` / `30000` | after an unanswered judgement the next start is spaced out (`base * 2^n`, capped) instead of burning one call per candidate |
| `warmupAttempts` / `warmupRetryDelayMs` | `3` / `5000` | how long startup keeps trying to load the local model before real judgements begin |
| `documentFragments` / `fragmentChars` | `true` / `200` | index each document's `##` sections as their own cards |
| `systemPromptNote` | `true` | register the constant explanation section in the system prompt |
| `reinjectTokenDistance` / `repeatToolLimit` / `repeatWindowSteps` | `20000` / `3` / `12` | long-session criteria: forgotten injections, going in circles |
| `termRejectLimit` / `termBlockCooldownMs` | `3` / `1800000` | term reputation: a term rejected this often without ever passing is cooled down |

## What it writes, and what it costs

- State only, under `stateDir`: `logs/observe.ndjson` (rotated at 32 MB) and `cache/cards.json`.
  Nothing is written inside `node_modules`, and no file of yours is modified.
- Retrieval and judging use the configured endpoints (localhost by default), with no telemetry. A custom
  endpoint receives the context/card or embedding query needed for its request. Logs contain keyword
  context and injected card text. The relevance judge runs as a local `node` subprocess.
- Context cost is bounded: at most `maxInjectionsPerTurn` injection blocks per turn, each ≤
  `maxInjectBytes`, with at most `maxCardsPerInjection` cards per block. Injected text counts toward host
  model input tokens.

## Uninstall

```sh
dsh plugin --profile web remove dsh-experience-recall
```

Then restart. Delete `$DSH_HOME/dsh-experience-recall/` if you also want the log and cache gone.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Injections never happen | check the store paths, injection quota, model and endpoint; an unavailable judge drops candidates instead of guessing. Built-in seed terms do not require the model |
| The log shows many `rejected` verdicts and few `inject` | the judge rejects weak or uncertain matches. `/experience-recall` and `term-cooldown` show term reputation; unanswered judgements do not count against a term |
| Nothing is injected for the first minutes after a restart | the local model is loading. Since 0.6.2 a timed-out judgement retries with a longer budget instead of cancelling that load |
| First start is slow | the card cache is being built: one local model call per memory. Prebuild it with `node node_modules/dsh-experience-recall/tools/build-cards.mjs --cache <stateDir>/cache/cards.json` |
| Nothing at all after install | the plugin needs a restart; check `ready` in the log and that `command-registered` / `system-prompt-section` / `token-meter` appear |

## Development

Layout:

| Path | What is in it |
|---|---|
| `lib/index.js` | wiring: per-agent subscriptions to `session/event` and `agent/pre-step`, the `/experience-recall` command, the constant system-prompt section, the token meter |
| `lib/observer.js` · `lib/scan.js` | turn session events into scannable text segments |
| `lib/keywords.js` · `lib/table.js` · `lib/terms.js` | the vocabulary: matching, the live term table, term extraction and shape gates |
| `lib/cards.js` | builds cards (local model + mechanical fallback + document fragments) and owns the disk cache |
| `lib/mnemon-store.js` · `lib/memory-watch.js` | read the memory store (read-only `node:sqlite`) and reconcile it incrementally |
| `lib/recall.js` | the `mnemon` CLI search (hard timeout, cache, silent degradation) |
| `lib/verify.js` · `tools/check-relevance.mjs` | the second-stage relevance judge (serialized, retried, backed off) |
| `lib/controller.js` · `lib/render.js` · `lib/surface.js` | gates, queue, injection boundary; rendering; visibility checks |
| `tools/` | CLI tools: `check-install`, `build-cards`, `term-audit`, `verdict-report`, `judge-probe`, `verify-package`, and the local evaluation harness |
| `test/` | 124 tests on node's built-in runner |

Commands (no install step is needed — the plugin has no dependencies):

```sh
npm run check                            # syntax check every runtime module
npm test                                 # 124 unit tests, no network
node tools/check-install.mjs             # installation self-check
node tools/verify-package.mjs            # simulate the published package from `files`
node tools/verdict-report.mjs            # runtime data: sources, scores, judge health
node tools/judge-probe.mjs --n 3         # probe the judge against the real endpoint
```

`lib/config.js` holds `PLUGIN_VERSION`, which mirrors `package.json`; `prepack` runs the syntax check and
the test suite, so a broken package cannot be published. CI runs the same two commands on Ubuntu and
Windows with Node 24.

The labelled pairs used to calibrate the judge prompt are **not** in this repository: they are drawn from
the author's private memory excerpts, so `tools/judge-ab.mjs`, `tools/calibrate.mjs` and
`tools/relevance-lab.mjs` only exist in the author's checkout. Everything needed to run, test and package
the plugin is here.

## Links

- DeepSeek Harness — the host this plugin runs in
- [dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) — the memory store and `mnemon` CLI it reads
- [awesome-dsh-plugin](https://awesome-dsh-plugin.com) — the curated list behind the DSH marketplace;
  GitHub topic `dsh-plugin`

## License

MIT
