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

## Pipeline (golden-quality, three stages)

1. **Research** — `deepseek-v4-flash` drives the pi-research SDK's multi-source
   research (reasoning off).
2. **Extraction** — the same model turns the raw report into structured findings
   using a strict prompt (verbatim-quote requirement + a 4-part, ≥120-word
   `whyBad` analysis template).
3. **Review** — `gemma-4-26b-a4b-it` (low reasoning) adversarially verifies each
   finding against its source via the research tool, then a stealth-browser
   existence check confirms the URL is live before it's added.

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
`findings.json` with category/severity filters and a client-side semantic search
(MiniLM embeddings computed in the browser — no server, no knowledge store).
