# Internals

How `dsh-experience-recall` turns session activity into one injected message, and
what each layer is allowed to do. This page is for people reading or changing the
code; the user-facing entry is [README.md](../README.md).

## Pipeline

```text
session/event (reasoning · text · tool arguments · tool results · errors)
  → mechanical keyword match against a vocabulary derived from your memories   (free, no model)
  → gates: once per term per turn · once per memory · cooldown · per-turn quota
  → local small model judges "does this lesson change what I should do next?"  (serialized, ~0.4 s)
  → the ready result is appended at the next agent/pre-step boundary
```

The boundary never waits. If retrieval or judging has not finished when the next
step starts, that step proceeds and the card arrives one boundary later. Nothing
is injected on a guess: an unparsable or uncertain judgement is dropped.

## Where the vocabulary comes from

The term table is not hand-written. It is derived from two sources and then
filtered:

- Your memory store: author tags and entities, plus the proper nouns in the
  stored text.
- Your project documents, including each document's `##` sections, which are
  indexed as their own cards.

Terms that cannot discriminate anything — file attributes, storage column names,
generic file names, anything with an `=` or `:` in it, anything shorter than two
letters — are rejected by shape rules rather than by a blocklist. Documents whose
title yields no usable term are not cached at all, so they can never trigger.
New memories are picked up after a `mnemon_*` tool call.

Each memory becomes one card: a single reusable sentence plus its trigger terms.
Cards are built with the local model; a build that fails because the model did not
answer reuses the previous card for the same id instead of caching a mechanical
fallback. The card revision carries the prompt version, so bumping the prompt
rebuilds cards rather than orphaning the live ones.

## Judging, retries and backoff

The judge is a local model call, serialized so calls never stack. Two failure
modes shaped the current behaviour:

- Ollama cancels a model load when its HTTP client disconnects. Aborting a call at
  the judgement budget and immediately asking again therefore kept killing the
  load it was waiting for; measured once as 52 aborted loads in a row. A timed-out
  judgement now retries once with a much longer budget (`verifyRetryTimeoutMs`).
- After an unanswered judgement the next start is spaced out exponentially
  (`verifyBackoffBaseMs` → `verifyBackoffMaxMs`) instead of burning one call per
  candidate. An unanswered judgement is counted separately from a rejection
  (`inconclusive`), so it never damages a term's reputation.

## Host compatibility

An injected message carries a DSH v4 producer-owned source,
`kind: "plugin:dsh-experience-recall"` — the same kind the host's own v3→v4
migration derives for a third-party plugin name. Reading also recognises the
pre-v4 `{ kind: "plugin", plugin }` wrapper, so injections recorded by a 0.6.x /
0.7.0 session are still treated as plugin messages for visibility, de-duplication,
the re-injection distance and the window scan, and never as user input.

DSH `0.1.7-rc.2` and later refuse the retired wrapper outright
(`format v4 message requires a producer-owned source kind`), which is why the
write path uses the producer-owned kind.

## Layout

| Path | What is in it |
|---|---|
| `lib/index.js` | wiring: per-agent subscriptions to `session/event` and `agent/pre-step`, the `/experience-recall` command, the constant system-prompt section, the token meter |
| `lib/models.js` · `lib/model-command.js` | `/experience-recall model`: list the local models, rank them into options, switch and write the profile back (no host API, so it tests offline) |
| `lib/observer.js` · `lib/scan.js` | turn session events into scannable text segments |
| `lib/keywords.js` · `lib/table.js` · `lib/terms.js` | the vocabulary: matching, the live term table, term extraction and shape gates |
| `lib/cards.js` | builds cards (local model + mechanical fallback + document fragments) and owns the disk cache |
| `lib/mnemon-store.js` · `lib/memory-watch.js` | read the memory store (read-only `node:sqlite`) and reconcile it incrementally |
| `lib/recall.js` | the `mnemon` CLI search (hard timeout, cache, silent degradation) |
| `lib/verify.js` · `tools/check-relevance.mjs` | the second-stage relevance judge (serialized, retried, backed off) |
| `lib/controller.js` · `lib/render.js` · `lib/surface.js` | gates, queue, injection boundary; rendering; visibility checks |
| `tools/` | CLI tools: `check-install`, `build-cards`, `term-audit`, `verdict-report`, `judge-probe`, `verify-package`, plus the local evaluation harness |
| `test/` | the test suite on node's built-in runner |

## Commands

```sh
npm run check                            # syntax check every runtime module
npm test                                 # unit tests, no network
node tools/check-install.mjs             # installation self-check
node tools/verify-package.mjs            # simulate the published package from `files`
node tools/verdict-report.mjs            # runtime data: sources, scores, judge health
node tools/judge-probe.mjs --n 3         # probe the judge against the real endpoint
```

No install step is needed: the plugin has no runtime dependencies. `lib/config.js`
holds `PLUGIN_VERSION`, which mirrors `package.json`; `prepack` runs the syntax
check and the test suite, so a broken package cannot be published. CI runs the
same two commands on Ubuntu and Windows with Node 24.

The labelled pairs used to calibrate the judge prompt are not in this repository:
they are drawn from private memory excerpts, so `tools/judge-ab.mjs`,
`tools/calibrate.mjs` and `tools/relevance-lab.mjs` only exist in the author's
checkout. Everything needed to run, test and package the plugin is here.

## Reading the log

`$DSH_HOME/dsh-experience-recall/logs/observe.ndjson` records:

- `trigger` — which term fired and where.
- `recall` — phases `queued` / `scores` / `result` / `rejected` / `dropped`, with
  the scores and, for a rejection, the judge's reason.
- `verify` — `outcome: accepted | rejected | inconclusive | retry`, latency and
  attempt count; verdict records also carry which half of the vocabulary fired
  (`source` / `termKind`) and how common the term is (`df`).
- `inject` — the cards and byte count that actually reached the message.
- `visibility` — a card that was still in context, or that had drifted too far to
  influence anything and could therefore be injected again.
