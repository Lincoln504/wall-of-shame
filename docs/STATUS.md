# Status

_Snapshot: June 2026._

- **Corpus:** ~1,300 verified entries across 19 categories, served from
  `agent/data/findings.json`.
- **Site:** live at [wallofshame.io](https://wallofshame.io) — feed, debounced hybrid search,
  id-based permalinks, and client-side share cards. Deploys automatically from `main`.
- **Pipeline:** stable three-model flow (gemma research + desk audit, qwen extraction/review,
  deepseek grounding/verify). Article-grounding coverage trends up via the maintenance audit.
- **Ingestion:** paused. The scale loop is designed to run continuously, but research is currently
  turned off — the corpus is frozen at a stable point and no background processes are populating it.
  Restart with `bash agent/scale-loop.sh` (see [RUNNING.md](RUNNING.md)).

## Known tradeoffs / notes

- Two categories are structurally tiny — `media` (~1) and `current_affairs` (~3) — because the
  classifier correctly routes topical pieces to their real subject, leaving these as residual.
  Candidates for consolidation if a cleaner taxonomy is wanted.
- The feed's category-coverage guarantee surfaces every non-exhausted category within ~N steps
  (N = live category count); tiny categories appear once then exhaust gracefully.
- Embeddings are recomputed in CI on every deploy, not committed by the loop.
