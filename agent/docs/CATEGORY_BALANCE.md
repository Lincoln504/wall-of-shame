# Category balance — soft top-N throttle

Status: IMPLEMENTED (`main.ts`, `--all` discovery rounds). Default on, env-tunable.

## Goal (intentionally loose)

Do NOT enforce a strict per-category ratio. If a category genuinely has more qualifying
content, more of it entering the corpus is valid. The only aim is to research the
**most-populated categories less frequently**, so the leaders stop pulling away over time.

## Observed imbalance (corpus ~874 entries, 19 categories)

economics 11.0% · healthcare 9.6% · labor 8.6% … media 2.3% · current_affairs 1.9%.
max/min 5.65 · CV 0.45. Real but moderate.

## Root cause

The scale loop runs `--all`, so every round researches all 19 categories equally
(`getBatch` round-robin is unused under `--all`). The imbalance is **yield-driven**:
content-rich topics surface more qualifying op-eds per visit than thin ones.
(`health` = health *misinformation*; `healthcare` = for-profit-medicine political economy —
intentionally distinct, not a duplicate.)

## Mechanism (`throttleSaturated` in `main.ts`)

Each `--all` discovery round:
1. Count current entries per category from `findings.json`.
2. Take the current top-N categories (default N=4: economics, healthcare, labor, climate…).
3. Drop each of those independently with probability THROTTLE (default 0.5) for this round.
4. Never return an empty round; seed re-evaluation and partial cursor rounds are untouched.

Effect: the top categories are researched ~half as often as the rest, so the tail catches
up gradually. Thin categories keep their full frequency (you can't manufacture op-eds that
don't exist), so nothing is starved.

Knobs:
- `PI_RESEARCH_TOP_THROTTLE` — skip probability, `0` disables (default `0.5`).
- `--throttle-top N` — how many leading categories to down-weight (default `4`).

## Explicitly dropped

An earlier idea to interleave new entries 50/50 into the existing order and freeze an
explicit rank was considered and **dropped** as too heavy. Ordering stays derived from
`foundAt` (newest batch on top, de-clustered, locked by id hash — see `site/src/order.ts`).
