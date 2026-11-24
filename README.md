# dsh-experience-recall

English | [简体中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-experience-recall?style=flat)](https://www.npmjs.com/package/dsh-experience-recall)
[![CI](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/OverDustD7/dsh-experience-recall/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-informational?style=flat)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat)](LICENSE)

**Your agent forgets what it learned in other projects. This plugin hands it back at the right moment.**

It watches what the model is doing — its reasoning, its tool calls, its failures — and when the running
work matches something your memory store already learned somewhere else, it injects that one lesson as a
short message right before the next step. Everything runs locally: the keyword table, the retrieval and
the relevance judge use your own machine by default. Injected messages still consume the host model's
context and input tokens.

## Status and support

- Status: maintained.
- Supported: DSH `>= 0.1.5-rc.1`; Node `>= 22.5` (24.x recommended); a local Ollama-compatible endpoint
  for the judge and the card builder.
- Not supported: hosts without a reachable local model — the plugin still observes and writes its log, but
  injects nothing; other model providers are not a configuration this project tests.
- Current version: the npm badge above. Repository tags are not updated on every publish.

## Requirements

| Need | Why | Without it |
|---|---|---|
| DSH `>= 0.1.5-rc.1` | host | — |
| Node `>= 22.5`, 24.x recommended | `node:sqlite` reads the memory store. Node 22.5–22.12 and 23.0–23.3 require `--experimental-sqlite`; Node 22.13+ (22.x), 23.4+ (23.x) and later majors do not | the plugin still runs, but the memory-derived vocabulary is empty (documents and seed terms keep working) |
| [dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) + the `mnemon` CLI | memory indexing and semantic search | without the CLI, already indexed cards can still trigger; CLI search is unavailable |
| A local model on Ollama (`http://localhost:11434`, default `mimo-v2.6:9b-q6_K`) | builds the cards and judges relevance | it observes and logs, but **injects nothing** — it refuses to guess |

Any Ollama-compatible endpoint works through `localEndpoint`. A proxy in front of Ollama that keeps the
client port is fine as long as it answers `POST /api/chat`; a proxy that returns 503 under load is treated
as an unanswered judgement, not as a reason to inject.

The SQLite flag conditions follow the [official Node.js module history](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html#sqlite). They describe the documented version requirements; not every supported Node version has been tested locally.

## Installation

### Recommended

```bash
dsh plugin --profile web add dsh-experience-recall
```

`web` is the profile behind the DSH web UI — substitute your own profile name if you renamed it. The
command forwards its arguments to pnpm in the profile directory.

Success signal: the command reports the package as added, and after restarting `dsh web` the chat command
`/experience-recall` prints a status block instead of "unknown command".

### Other verified methods

The same command accepts a repository or a local checkout:

```bash
# track this repository instead of the npm release
dsh plugin --profile web add github:OverDustD7/dsh-experience-recall

# development: install the checkout you are working in
dsh plugin --profile web add link:/path/to/dsh-experience-recall
```

Installing already adds the package to the profile's `dsh.profile.bundles` — do not add it by hand as
well, or the loader fails with `duplicate loader entry id`.

## Quick start

1. Install with the command above and restart `dsh web`.
2. Do a few minutes of real work in a session.
3. Type `/experience-recall`.

Seeing the status block with non-zero scan counters means it works; it also reports how many judgements the
judge accepted, rejected or never answered, with average latency and retry count. The first injection
appears the next time your work matches something in the store. On a fresh install the first start builds
one card per memory with the local model (a few hundred memories ≈ 5 minutes), and the vocabulary is thin
until that finishes.

Optional, once it runs:

```text
/experience-recall model                    # list the local models and pick one
/experience-recall model qwen3.6:35b-a3b    # switch straight to it, no picker card
/experience-recall help                     # subcommand help
```

The picker asks Ollama what chat models are installed; embedding models such as `bge-m3` are never
offered. The choice applies immediately — the judge and the card builder read the value per call — and is
written back to your profile patch so the next restart keeps it. Cards already built keep the previous
model's wording. A wrong name is safe: if the model is not installed the command says so and cards fall
back to the mechanical builder.

### What an injection looks like

An illustrative example of the injected format. The card text below is made up for this README — no real
memory is shown, and `MEMORY_ID` is a placeholder.

```text
【可能相关的历史经验 · 来自其他项目】
· 处理跨设备配置冲突时，先用只读副本比对两侧提交，再决定以哪一侧为准（记忆 id: MEMORY_ID）

需要细节：用 mnemon_recall / document_search 取全文。
```

The card is deliberately one line with the reusable conclusion, plus an id so the model can pull the full
memory if it needs it. At most a few of these per turn, ~1.2 KB each.

## Configuration, data and permissions

Data and permission summary:

- Data processed: DSH session events and the contents of your mnemon memory store, read-only through
  `node:sqlite`. No telemetry, no analytics.
- Network: by default the plugin talks only to a local endpoint (`http://localhost:11434`). If you point
  `localEndpoint` at a remote endpoint, it receives context and card text for building and judging.
  CLI retrieval uses the separately configured `mnemonEmbedEndpoint`, which receives embedding queries.
- Stored at: `$DSH_HOME/dsh-experience-recall/` — `logs/observe.ndjson` (rotated at 32 MB) and
  `cache/cards.json`. Logs contain keyword context and injected card text. Nothing is written inside
  `node_modules`.
- Files it changes: its own state under `stateDir`, plus your profile patch when `/experience-recall model`
  records a model choice. Your memory store is not written to, and no other file of yours is modified.
- Permissions required: no special OS permissions. Read access to the mnemon store and network access to the
  configured endpoint.

Everything in the table below is optional and lives in the row's `config` — either in the package's
`cordis.patch.yml` or, better, in your own profile patch
(`$DSH_HOME/profiles/{{PROFILE_NAME}}/cordis.patch.yml`), which wins:

```yaml
- id: experience-recall
  config:
    maxInjectionsPerTurn: 0            # keep observing, inject nothing
    localModel: 'mimo-v2.6:9b-q6_K'
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `stateDir` | `$DSH_HOME/dsh-experience-recall` | where the log and the card cache live |
| `logPath` / `cardCachePath` | under `stateDir` | override individually; `cardCachePath: ''` disables the cache |
| `mnemonCliPath` | `$MNEMON_CLI_PATH` | the `mnemon` CLI; `''` disables CLI retrieval only |
| `mnemonDataDir` / `mnemonStore` | `$MNEMON_DATA_DIR` or `$DSH_HOME/mnemon` / `$MNEMON_STORE` or `default` | shared by the index reader and the CLI; unset `DSH_HOME` uses `~/.dsh` |
| `localModel` / `localEndpoint` | `mimo-v2.6:9b-q6_K` / `http://localhost:11434` | card builder + relevance judge (this is what `/experience-recall model` changes) |
| `modelListTimeoutMs` / `modelPickTimeoutMs` | `5000` / `300000` | timeout for fetching the installed-model list; how long the picker card waits for the human |
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

Context cost stays bounded: at most `maxInjectionsPerTurn` injection blocks per turn, each ≤
`maxInjectBytes`, with at most `maxCardsPerInjection` cards per block. Injected text counts toward host
model input tokens.

## Upgrade and uninstall

Upgrade by running the install command again; pnpm moves the dependency to the newest published version:

```bash
dsh plugin --profile web add dsh-experience-recall
```

Pin a specific version with `dsh plugin --profile web add dsh-experience-recall@{{VERSION}}`. After upgrading,
restart `dsh web`. The card cache and log survive an upgrade; a change to the card prompt rebuilds the
cards on the next start.

Uninstall:

```bash
dsh plugin --profile web remove dsh-experience-recall
```

Then restart. Removing the package leaves the state directory in place: delete
`$DSH_HOME/dsh-experience-recall/` as well if you want the log and the card cache gone. There is no other
persistent data; cards are rebuilt from the memory store when needed.

## Limitations and troubleshooting

Real limitations:

- The judge needs a local model. Without a reachable endpoint nothing is injected; the plugin is not a
  keyword-only injector by design.
- Recall quality is bounded by your own memory store. Sparse stores give sparse hits.
- The first start after a fresh install, or after a card-prompt change, spends minutes building cards.
- Injected text consumes host context and input tokens; the per-turn budget above is the only cap.
- Only your own store is read. The plugin is not a security tool and does not vet what your memories say.

| Symptom | Likely cause |
|---|---|
| Injections never happen | check the store paths, injection quota, model and endpoint; an unavailable judge drops candidates instead of guessing. Built-in seed terms do not require the model |
| The log shows many `rejected` verdicts and few `inject` | the judge rejects weak or uncertain matches. `/experience-recall` and `term-cooldown` show term reputation; unanswered judgements do not count against a term |
| Nothing is injected for the first minutes after a restart | the local model is loading. Since 0.6.2 a timed-out judgement retries with a longer budget instead of cancelling that load |
| First start is slow | the card cache is being built: one local model call per memory. Prebuild it with `node node_modules/dsh-experience-recall/tools/build-cards.mjs --cache {{STATE_DIR}}/cache/cards.json` |
| Nothing at all after install | the plugin needs a restart; check `ready` in the log and that `command-registered` / `system-prompt-section` / `token-meter` appear |

The install self-check reports where it looks and what it finds:

```bash
node node_modules/dsh-experience-recall/tools/check-install.mjs
```

Add `--cache` / `--log` if you moved the state directory. The running log is
`$DSH_HOME/dsh-experience-recall/logs/observe.ndjson`; `trigger` / `recall` / `verify` / `inject` /
`term-cooldown` answer "why did it inject, or why didn't it".

## Development

```bash
npm run check                            # syntax check every runtime module
npm test                                 # unit tests, no network
node tools/verify-package.mjs            # simulate the published package from `files`
```

No install step is needed: the plugin has no runtime dependencies. `lib/config.js` holds
`PLUGIN_VERSION`, which mirrors `package.json`; `prepack` runs the syntax check and the test suite, so a
broken package cannot be published. CI runs the same two commands on Ubuntu and Windows with Node 24.

Layout, the retrieval/judging pipeline, host-compatibility details and log fields are below, so this page is
self-contained on GitHub and on npm alike.

<details>
<summary>Technical notes: pipeline, vocabulary, retries, layout, log fields</summary>

**Pipeline.** Session events (reasoning, text, tool arguments, tool results, errors) are matched against a
vocabulary derived from your memories — free, no model. Gates then limit how often a match may fire: once per
term per turn, once per memory, a cooldown, and the per-turn quota. A local small model judges whether the
lesson would change what happens next (serialized, ~0.4 s), and the ready result is appended at the next
`agent/pre-step` boundary.

The boundary never waits. If retrieval or judging has not finished when the next step starts, that step
proceeds and the card arrives one boundary later. Nothing is injected on a guess: an unparsable or uncertain
judgement is dropped.

**Vocabulary.** The term table is derived from your memory store (author tags and entities plus the proper
nouns in the stored text) and from your project documents, including each document's `##` sections. Terms that
cannot discriminate anything — file attributes, storage column names, generic file names, anything containing
`=` or `:`, anything shorter than two letters — are rejected by shape rules, not by a blocklist. A document
whose title yields no usable term is not cached at all. Each memory becomes one card: a reusable sentence plus
its trigger terms, rebuilt when the card prompt version changes.

**Judge retries and backoff.** Ollama cancels a model load when its HTTP client disconnects, so aborting a call
at the judgement budget and immediately asking again kept killing the load it was waiting for (measured once as
52 aborted loads in a row). A timed-out judgement now retries once with a much longer budget, and after an
unanswered judgement the next start is spaced out exponentially. An unanswered judgement is counted separately
from a rejection, so it never damages a term's reputation.

**Host compatibility.** An injected message carries a DSH v4 producer-owned source,
`kind: "plugin:dsh-experience-recall"`. Reading also recognises the pre-v4 `{ kind: "plugin", plugin }` wrapper,
so injections recorded by an older session are still treated as plugin messages for visibility, de-duplication,
the re-injection distance and the window scan — never as user input.

**Layout.**

| Path | What is in it |
|---|---|
| `lib/index.js` | wiring: per-agent subscriptions to `session/event` and `agent/pre-step`, the `/experience-recall` command, the constant system-prompt section, the token meter |
| `lib/models.js` · `lib/model-command.js` | `/experience-recall model`: list local models, rank them, switch and write the profile back |
| `lib/observer.js` · `lib/scan.js` | turn session events into scannable text segments |
| `lib/keywords.js` · `lib/table.js` · `lib/terms.js` | the vocabulary: matching, the live term table, extraction and shape gates |
| `lib/cards.js` | builds cards (local model + mechanical fallback + document fragments) and owns the disk cache |
| `lib/mnemon-store.js` · `lib/memory-watch.js` | read the memory store and reconcile it incrementally |
| `lib/recall.js` | the `mnemon` CLI search (hard timeout, cache, silent degradation) |
| `lib/verify.js` · `tools/check-relevance.mjs` | the second-stage relevance judge |
| `lib/controller.js` · `lib/render.js` · `lib/surface.js` | gates, queue, injection boundary, rendering, visibility |
| `tools/` | CLI tools: `check-install`, `build-cards`, `term-audit`, `verdict-report`, `judge-probe`, `verify-package` |
| `test/` | the suite on node's built-in runner |

**Log fields.** `$DSH_HOME/dsh-experience-recall/logs/observe.ndjson` records `trigger` (which term fired and
where), `recall` (phases `queued` / `scores` / `result` / `rejected` / `dropped`, with the judge's reason),
`verify` (`outcome: accepted | rejected | inconclusive | retry`, latency, attempt count, `source` / `termKind`
and `df`), `inject` (cards and bytes that actually reached the message) and `visibility` (a card still in
context, or one that drifted too far to influence anything).

</details>

The labelled pairs used to calibrate the judge prompt are **not** in this repository: they are drawn from
private memory excerpts, so `tools/judge-ab.mjs`, `tools/calibrate.mjs` and `tools/relevance-lab.mjs` only
exist in the author's checkout. Everything needed to run, test and package the plugin is here.

## Feedback and security

- Issues: [github.com/OverDustD7/dsh-experience-recall/issues](https://github.com/OverDustD7/dsh-experience-recall/issues)
- Security: no private security channel is currently offered. Do not post credentials, memory excerpts or
  other sensitive details in a public issue; describe the report without the payload and wait for a
  maintainer to open a private route.

## License and third-party notices

License: MIT, see [LICENSE](LICENSE).

No third-party code is bundled or required at runtime. The plugin talks to DSH, to the optional
[dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) memory store and CLI, and to a local Ollama
endpoint; each of those remains under its own license and is installed separately.

The host this plugin runs in is DeepSeek Harness. Related entry points:
[dsh-mnemon](https://www.npmjs.com/package/dsh-mnemon) ·
[awesome-dsh-plugin](https://awesome-dsh-plugin.com) (GitHub topic `dsh-plugin`).
