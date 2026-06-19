# Architecture

Wall of Shame is two things in one repo:

1. **`agent/`** — a Node/TypeScript ingestion pipeline that drives the
   [pi-research](https://github.com/Lincoln504/pi-research) SDK to discover, analyze, and
   verify harmful English-language web content, writing a JSON corpus.
2. **`site/`** — a static SolidJS single-page app (GitHub Pages → `wallofshame.io`) that
   renders that corpus. No server: everything runs in the browser.

It doubles as a real-world **audit harness for pi-research itself** — every round exercises the
SDK end-to-end and records per-stage telemetry.

## Ingestion pipeline (per category, per round)

All models are served via OpenRouter:

1. **Research** — `gemma-4-26b-a4b-it` drives the pi-research SDK's multi-source search →
   stealth scrape (Camoufox) → synthesis.
2. **Extraction** — `qwen3.6-35b-a3b` turns the raw research report into structured findings
   (verbatim-quote requirement, numbered `whyBad` analysis with named fallacies, severity rubric).
3. **Review / desk audit** — `gemma-4-26b-a4b-it` scope-gates each finding and checks quotes/claims
   against the report (no web tool).
4. **Grounding / verify** — `deepseek-v4-pro` re-scrapes each finding's own source and confirms the
   summary/quotes are supported by the live article; unsupported or unscrapeable findings are dropped.
5. **Admit** — survivors are deduped (see below) and appended to `agent/data/findings.json`.

There are **19 categories** (`agent/src/categories.ts`), each with a key, name, and a description of
the propaganda strategies it covers.

## Deduplication

State lives in `agent/data/run-state.json` (`seenUrls`, keyed per category, unioned globally).
Policy:

- Every URL that reaches the wall — plus duplicates, failed-verification, and audit/quality removals —
  is **tombstoned** so it is never reprocessed.
- The **only** exception is category-balance throttling: a category skipped for balance is never
  fetched, so it stays eligible for a future round (it never reaches the tombstone path).

Permalinks are **id-based** (`/<8-hex-id-prefix>`), resolved by exact-or-prefix match (oldest match
wins on the rare collision), so a shared link stays stable as the corpus grows — no positional drift.

## The scale loop (`agent/scale-loop.sh`)

Sequential rounds (never two at once — single-writer on `findings.json`):

- Each round researches **all** categories, with a soft **throttle** that skips the current top-6
  most-populated categories at p=0.6 (damps the leaders without starving anyone).
- An **underpopulated follow-up pass** then re-researches the thinnest viable categories so laggards
  keep pace (sequential, dedup-safe).
- Every 3 rounds, a **maintenance audit** reviews recent entries + a **fixed-size** older-corpus
  sample (~150, env `WOS_AUDIT_OLDER_SAMPLE`) — fixed, not a percentage, so audit cost stays flat as
  the corpus grows. It re-grounds not-yet-grounded entries and QA-samples grounded ones.
- A **flagged-resolution** pass attempts to fix or remove entries the audit flagged.
- The loop commits `findings.json` and pushes; embeddings are **not** computed locally (CI does it).

## Site (`site/`)

- **Feed** (default) — a full-bleed one-card carousel driven by a weighted-random sequencer
  (`sequencer.ts`): read-time category affinity, severity inverse-frequency, run-length caps, a
  **session no-repeat** guarantee, and a **category-coverage** guarantee (every category surfaces
  within ~N steps, N = live category count).
- **Search** — debounced (0.6s) hybrid keyword + semantic relevance. Document vectors are precomputed
  in CI (`granite-embedding-small-english-r2`, q8) and shipped as a static artifact; only the short
  query is embedded in-browser (ONNX WASM). Results are a single capped relevance list.
- **Entry** — `/<id>` permalink, a single card; the share target.
- **Share card** — a themed PNG rendered client-side on `<canvas>` (`sharecard.ts`).
- Category/severity filters, CSV/JSON download, optional visitor counter, self-hosted Inter font.

## Deploy

`.github/workflows/deploy.yml` copies `agent/data/findings.json` → `site/public/`, recomputes
`embeddings.bin`/`.meta.json` from it, builds the SPA, and deploys to GitHub Pages. The custom domain
`wallofshame.io` is set via `site/public/CNAME`.
