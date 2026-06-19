# Running

## Prerequisites

- Node (project uses Node 25 in CI; any recent LTS works for the site).
- An `openrouter` provider authed for the pi-research SDK (or `OPENROUTER_API_KEY` in CI).
- Browser scraping uses the Camoufox stealth binary (auto-managed by pi-research).

## Agent (ingestion)

```bash
cd agent
npm install

# One discovery round over all categories:
npx tsx src/main.ts --all --concurrency 8 --no-commit

# List what a round would do, no API calls:
npx tsx src/main.ts --all --dry-run

# Quality gates:
npm run typecheck
npm test
```

### Continuous scaling

```bash
cd agent
bash scale-loop.sh            # indefinite; sequential rounds + audits, commits + pushes
```

Never run two loop processes at once — `findings.json` is single-writer and concurrent writers
cause lost updates.

Useful env knobs:

- `PI_RESEARCH_TOP_THROTTLE` (default 0.6) + `--throttle-top` (default 6) — leader damping.
- `WOS_BOOST_BOTTOM` (4) / `WOS_BOOST_MIN_VIABLE` (12) — underpopulated follow-up pass.
- `WOS_AUDIT_OLDER_SAMPLE` (150) — fixed maintenance-audit older-corpus budget.

## Monitor

```bash
node agent/scripts/monitor.mjs   # corpus size, throughput, errors, verification coverage
```

## Site

```bash
cd site
npm install
npm run dev        # local dev server
npm run build      # production build → dist/
npm run smoke      # headless mount + render check

# Regenerate precomputed search embeddings (also done in CI):
node scripts/embed.mjs

# Regenerate the social/OG link-unfurl card after a branding change:
node scripts/render-og.mjs
```

Deploy is automatic: pushing to `main` runs `.github/workflows/deploy.yml`, which syncs the corpus,
recomputes embeddings, builds the SPA, and publishes to GitHub Pages (`wallofshame.io`).
