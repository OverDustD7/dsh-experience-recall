# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] — 2026-09-30

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
