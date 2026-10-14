# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.2] — 2026-10-14

### Changed

- **The context window is now 32768 everywhere this plugin talks to Ollama.** The in-session judge
  (`tools/check-relevance.mjs`), the config default (`localNumCtx`) and the card builder's fallback were
  4096 / 8192 / 8192. Ollama reloads a model whenever a request's `num_ctx` differs from what is loaded,
  and the chat-digest scripts on the same machine already ask for 32768 — so alternating between the two
  clients meant loading and evicting the 9B model on every switch. The lab scripts (`calibrate.mjs`,
  `card-lab.mjs`, `judge-ab.mjs`, `relevance-lab.mjs`) were unified for the same reason: running one by hand
  otherwise pays a reload. `localModel` and `localKeepAlive` are untouched.

### Fixed

- **No child process flashes a console window any more.** `tools/verify-package.mjs` had two `spawnSync`
  calls, one of which (the packed-judge smoke run) passed no `windowsHide`; both are hidden now, so running
  the release check no longer pops a black box. `lib/recall.js`, `lib/verify.js` and `tools/judge-probe.mjs`
  already passed it. A new guard test (`test/spawn-hide.test.mjs`) scans every `spawn` / `spawnSync` /
  `spawnImpl` call site under `lib/` and `tools/` and fails if any of them loses `windowsHide: true`.

## [0.8.1] — 2026-10-14

### Added

- `localKeepAlive` config key (default `30m`): the judgement request and the card-building request now carry
  Ollama's `keep_alive`, so the local small model is not evicted between two calls just because it sat idle.
  An empty string sends no `keep_alive` at all (leave the server's `OLLAMA_KEEP_ALIVE` in charge); an
  unparsable value falls back to the default. Defensive on machines that already export a long
  `OLLAMA_KEEP_ALIVE` (measured no change there), decisive on machines that do not.

### Docs

- `DEV_NOTES.md` §4.18: the full attribution of the "judgement keeps maxing out the GPU" report — who really
  asks for 131072 / 262144 context (the mimo and vision models' own Modelfiles, plus another client's
  `/api/chat` traffic; this plugin's three channels asked for 4096 / 8192 / no `num_ctx` at the time, later
  unified to 32768 in 0.8.2), what the
  eviction predictions were, and why the plugin was the victim rather than the cause.

## [0.8.0] — 2026-10-14

### Added

- **`/experience-recall model` — switch the local small model from inside the session.** With no argument the
  command asks the local Ollama (`GET /api/tags`) what chat models are installed and shows a question card:
  the model in use first, the rest sorted smallest-first, embedding models (`bge-m3` and friends, recognised
  by family) never offered, and the list capped at 20 with the remainder stated on the card. With an argument
  (`/experience-recall model qwen3.6:35b-a3b`) it switches straight to that name and skips the card. The
  switch is applied live and then written into this plugin's own loader entry through
  `ctx.configEditor.edit`, so it survives a restart; a failed write is reported instead of swallowed ("takes
  effect now, not persisted"), and a name that is not installed (or an Ollama that cannot be reached) is
  called out while still being written.
- `lib/models.js` — install listing (`GET /api/tags`, HTTP error, unreachable endpoint and timeout all become
  a value, never a throw), embedding detection, byte/detail formatting, and the option ranking.
- `lib/model-command.js` — parsing (`status` / `help` / `model` / `model <name>`), the command itself with
  every host effect injected (config read, live write, listing, question card, profile write, observation
  log), so all of its decisions are testable offline.
- `modelListTimeoutMs` (5000) and `modelPickTimeoutMs` (300000): the listing timeout, and how long the picker
  card waits for the human before it gives up.
- 15 tests (the suite goes 130 → 145): `test/model-command.test.mjs` covers parsing, ranking, the embedding
  filter, an unreachable Ollama, a missing model, a refused write and both answer paths;
  `test/verify.test.mjs` pins that a model switched after startup reaches the next judgement.

### Fixed

- **Switching the model now actually reaches the judge.** `lib/verify.js` captured `config.localModel` when
  the verifier was created, so a model changed at runtime kept being ignored for the life of the process; it
  is now read per call, which is what the command's "no restart needed" promise depends on. `lib/cards.js`
  already read it per build, so cards follow immediately as well.
- The plugin's own `package.json#check` now syntax-checks `lib/models.js` and `lib/model-command.js` too —
  the two files a release would otherwise ship unparsed.

## [0.7.2] — 2026-09-29

### Fixed

- **Republished with the correct release date.** `0.7.1` went out with a changelog heading dated
  `2026-09-30`; the release happened on `2026-09-29`. (The repository also carried that wrong date in
  a comment inside `tools/verify-package.mjs`, which is a development script and is not part of the
  published package.) No code differs from `0.7.1` — this version exists so the published artifact
  matches the repository.

## [0.7.1] — 2026-09-29

### Fixed

- **Injected messages use the DSH v4 producer-owned source.** Harness `0.1.7-rc.2` refuses the
  retired `{ kind: "plugin", plugin: "<name>" }` wrapper outright — `format v4 message requires a
  producer-owned source kind` — so an injection could no longer be persisted. Messages now carry
  `{ kind: "plugin:dsh-experience-recall", form: "recall" }`, which is exactly what the official
  v3→v4 migration derives for a third-party plugin name (`producerKind()` in
  `dsh-session-format-v3-to-v4`), so stored history keeps a single shape. Verified offline against
  the shipped validator: the new shape is admitted, the retired one is refused.
- **Both source eras stay readable.** Visibility, the same-memory de-duplication gate, the
  re-injection distance lookup and the window scan all go through one predicate that accepts the
  native `plugin:<name>` kind and the historical `{ kind: "plugin", plugin }` wrapper, so injections
  written by a 0.6.x / 0.7.0 session still count as plugin messages and never as user input.
- **Backups can no longer ship.** `package.json#files` lists whole directories, so four `lib/*.bak`
  files (59,293 B) were travelling in the tarball while `tools/verify-package.mjs` still reported a
  passing layout. It now fails the release when the packed tree contains a `*.bak`, `*.orig`,
  `*.log`, `*.tmp-*` or `.DS_Store` file.

### Added

- `audit/_v4-source-check.mjs`: drives the real controller for one injection, runs that message
  through the **official** v4 row admission, and checks scanning, visibility and source recognition
  across both source eras.

## [0.7.0] — 2026-09-25

### Changed

- **Cards are built and judged for portability instead of relevance.** A card has to keep teaching
  something after the covering identifiers are removed; an empty card means no card, no terms and no
  trigger at all. Author tags and entities now outrank the model's own picks, and the judge asks
  whether an experience would still change the next step in a *different* project.
- **Trigger terms are filtered by shape rules instead of a blocklist.** `=` and `:` are refused,
  fewer than two letters is refused, and generic file names and filesystem/storage column names are
  refused — 418 unusable terms dropped while every real term survived.

### Fixed

- A card build that fails because the local model did not answer now reuses the previous card for
  the same id instead of caching a mechanical fallback, and the card revision carries the prompt
  version, so bumping the prompt rebuilds cards instead of orphaning the live ones.

## [0.6.2] — 2026-09-16

### Fixed

- **A judgement could livelock the local model.** Ollama cancels a model load when its HTTP client
  disconnects, so aborting a call at the judgement budget and immediately asking again kept killing
  the very load it was waiting for. Measured on 2026-09-16: **52 aborted loads in a row**, four
  minutes without a single usable judgement. A judgement that times out now retries **once** with a
  much longer budget (`verifyRetryTimeoutMs`, capped at 5× the normal budget).
- **"The judge did not answer" is no longer counted as "the judge said no".** It has its own counter
  (`stats.inconclusive`) and its own log flag, so acceptance rates per vocabulary source stay honest
  and an unanswered judgement still cannot damage a term's reputation.
- **The reason a judgement failed is no longer discarded.** The checker reports it as JSON on
  **stdout** while the host only kept stderr, which left 195 log records reading `exit 3:` with
  nothing after the colon — the smoke that hid the livelock above for a whole round.

### Added

- Exponential backoff after an unanswered judgement (`verifyBackoffBaseMs` / `verifyBackoffMaxMs`,
  2 s → 30 s), so a model that really is gone is not asked once per candidate.
- Warmup retries (`warmupAttempts` / `warmupRetryDelayMs`) instead of a single attempt at startup.
- A judge-health section in `tools/verdict-report.mjs`: outcomes, latency percentiles, fast vs slow
  failures, failure reasons, and the boot-window split.
- `tools/judge-probe.mjs` to probe the judge against the real endpoint, and
  `audit/_cold-retry-check.mjs` to reproduce the cold-load case on purpose.

## [0.6.1] — 2026-09-16

### Fixed

- 28 issues from a full source review, including: an incomplete store read must not trigger a
  destructive reconcile; a temporarily unreadable document must not be treated as a deleted one;
  a structurally invalid cache must refuse to overwrite the file; text without keyword hits must
  still feed the fallback context; candidates must be sorted before the per-event quota; stale async
  results must be discarded after a compaction, a session switch or an unload; every candidate in the
  injection budget must be judged, and only cards that actually reached the message may be accounted
  as injected; an inconclusive judgement must not damage term reputation; the configured endpoint
  must reach the checker; a child timeout must complete its own result; stdout must be decoded as a
  UTF-8 stream.

### Security

- The published package no longer ships the whole `tools/` directory: it now carries an explicit file
  list (`lib`, the three runtime/setup tools, `cordis.patch.yml`, both READMEs, `LICENSE`). The
  previous version shipped development evaluation data with private excerpts.
- Runtime state moved out of `node_modules`: the default state directory is
  `$DSH_HOME/dsh-experience-recall/`, so logs and the card cache survive an upgrade.

## [0.6.0] — 2026-09-14

### Added

- Publishable package form: `dsh.bundle.patch`, `engines`, `repository`, `publishConfig`, `prepack`.
- `tools/verify-package.mjs`: simulates the published package from `files` and asserts that the
  runtime files are really in it.
- User-facing `README.md` / `README.zh.md`; development notes moved to `DEVELOPMENT.md`.

## Earlier versions

`0.1.0`–`0.5.x` were the private development series: P0 scaffolding, P1 observation only,
P2 keyword match → retrieval → injection, P3 automatic vocabulary and local-model cards.
They were never published.
