# Wall of Shame

A repository of web content judged to be socially harmful — propaganda and
op-eds whose framing works to **normalize, justify, or hide** the harm of
regressive policies (across class, labor, economics, race, democracy, policing,
war, immigration, religion, climate, health, technology, disability, and
patriarchy/misogyny). Each entry is dissected with a scathing, evidence-grounded
analysis.

Built with [pi-research](https://github.com/Lincoln504/pi-research).

## Dual purpose: it is also a pi-research audit harness

Wall of Shame doubles as a real-world **test and audit harness for the
pi-research tool itself**. Every round drives the pi-research SDK end-to-end
(init → multi-source search → stealth scrape → synthesis → extraction → review →
verification) across 13 adversarial topics, and records granular, timestamped
telemetry: per-stage durations, success/failure rates (research, review,
verification, per-category), extraction yield, an error taxonomy, and
pi-research's own internal metrics (researchers launched, searches, URLs
analyzed/failed, fetch-vs-browser success, tokens, cost). Each run writes a JSON
audit artifact to `agent/data/runs/run-<timestamp>.json`.

## Pipeline (golden-quality, three stages — all gemma)

Every stage uses the cheap `gemma-4-26b-a4b-it` model. Cheapness is what makes
scaling to thousands of entries across many concurrent rounds affordable. The
**research** stage runs reasoning off (it drives the SDK's tool loop); the
**extraction** and **review** stages run at **medium reasoning** — that is what
produces the golden-era analytical depth (rich, numbered, named-fallacy `whyBad`
breakdowns with external context). Big-context pressure in the research stage is
bounded by SDK config (`MAX_SCRAPE_BATCHES` + the SDK's own context-gating), not
by swapping in a larger model.

1. **Research** — gemma drives the pi-research SDK's multi-source research.
2. **Extraction** — gemma (medium reasoning) turns the raw report into structured
   findings using a strict prompt: verbatim-quote requirement + a numbered,
   ≥150-word `whyBad` analysis (named fallacies, `External Context:`, and
   `CONFLICT OF INTEREST:` / `TIMELINESS NOTE:` where applicable) + a severity
   rubric.
3. **Review** — gemma (medium reasoning) runs a single-pass desk audit (no web
   tool): it scope-gates each finding (dropping neutral reporting / off-topic),
   checks every quote and claim against the research report it's given as context,
   and **preserves-or-strengthens** `whyBad` to the golden bar (never oversimplify).
   A stealth-browser existence check (`verifyUrl`) then confirms the URL is live
   before the finding is added.

The SDK runs with `PI_RESEARCH_DEBUG=true`, so full INFO+DEBUG diagnostics for the
tool under audit are written to `/tmp/pi-research.log` for post-hoc investigation.

The knowledge store is disabled (`KNOWLEDGE_STORE_MODE: 'none'`). Dedup state
(`run-state.json` `seenUrls`) is global across categories and rounds — a URL on
the wall is never re-researched or re-added.

## Lifecycle

1. **Restore (done)** — the proven golden 85-entry corpus is restored from
   history (81 in-scope), with all 85 URLs seeded into the dedup state.
2. **Discovery (steady state)** — general-search rounds find *new* sources,
   deduped against everything already seen, rotating/covering categories.
3. **Scale** — run rounds concurrently toward the target corpus size.

## Commands

```bash
cd agent
npm install

# Discovery (general search):
npx tsx src/main.ts --all --concurrency 4        # all 13 categories this round
npx tsx src/main.ts --batch-size 3               # 3 categories from the cursor
npx tsx src/main.ts --all --dry-run              # list categories, no API calls
npx tsx src/main.ts --all --no-commit            # run without git commit/push

# Seed re-evaluation of the curated legacy links (no general search):
npm run seed

# Interactive menu:
npm run cli

# Quality gates:
npm run typecheck
npm test
```

Required: an `openrouter` provider authed in `~/.pi/agent` (or `OPENROUTER_API_KEY`
in CI). Browser scraping uses the Camoufox stealth binary.

## Site

`site/` is a static SolidJS app (deployed to GitHub Pages) that renders
`findings.json`. Everything runs in the browser — no server, no knowledge store.

- **Filters + semantic search** — category/severity filters and a client-side
  MiniLM semantic search (embeddings computed in-browser).
- **Shuffled, interleaved order** — the default view uses a deterministic,
  id-hashed order (`order.ts`) that interleaves categories so no two adjacent
  entries share one. It is stable across loads (an entry keeps its place as the
  corpus grows), which is what lets a share image hard-code an entry's page.
- **Pagination** — 12 entries/page via hash routes (`#/page/N`), so deep links
  resolve client-side on GitHub Pages with no 404 dance.
- **Knuth-Plass justification** — article text is justified with the TeX total-fit
  algorithm + en-us hyphenation (`tex-linebreak`), applied after web fonts load and
  re-run on resize (`justify.ts`), with a CSS `text-align: justify` fallback.
- **Share as image** — each entry has a Share button that renders a 1080×1350
  (Instagram-portrait) themed card on a `<canvas>` with the same Knuth-Plass
  justified body and embedded fonts (`sharecard.ts`), then hands it to the Web
  Share API (`navigator.share` with a file) or downloads it. The card's footer
  links to the entry's page. The renderer + fonts are lazily imported on first use.
- **Visitor counter** — optional total + daily-UTC-reset counts via a tiny free
  Cloudflare Worker (`worker/`); set `VITE_COUNTER_URL` to enable, otherwise the
  counter is simply omitted.

Typography is self-hosted (Newsreader + Inter via `@fontsource`, no external CDN).
