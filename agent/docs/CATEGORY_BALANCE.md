# Category balance — risk assessment & meta-layer spec

Status: SPEC ONLY (not implemented). Recommended to implement **after** the corpus reaches
its 1500 target, so it does not alter the live scale run mid-flight.

## Observed imbalance (corpus = 874 entries, 19 categories)

| count | share | category |
|------:|------:|----------|
| 96 | 11.0% | economics |
| 84 | 9.6% | healthcare |
| 75 | 8.6% | labor |
| 57 | 6.5% | climate |
| 56 | 6.4% | war |
| 54 | 6.2% | corruption |
| 52 | 5.9% | gender |
| 49 | 5.6% | oligarchy |
| 44 | 5.0% | technology |
| 41 | 4.7% | democracy |
| 40 | 4.6% | religion |
| 38 | 4.3% | policing |
| 33 | 3.8% | spectacle |
| 33 | 3.8% | disability |
| 32 | 3.7% | immigration |
| 30 | 3.4% | race |
| 23 | 2.6% | health |
| 20 | 2.3% | media |
| 17 | 1.9% | current_affairs |

max/min ratio 5.65 · mean 46 · stddev 20.6 · **coefficient of variation 0.45**.

Verdict: real but **moderate** imbalance. Not a correctness risk; the corpus is usable as is.
It is an aesthetic/coverage concern that compounds slowly as the corpus grows.

## Root cause — it is NOT a selection bug

The scale loop runs `tsx src/main.ts --all`. In `main.ts` that takes the `all` branch:
`categories = CATEGORIES` — **every round researches all 19 categories equally**. The
round-robin `getBatch()` cursor is only used for partial (`--batch-size`) runs, never in the
`--all` scale loop.

So categories are *visited* equally. The imbalance is entirely **yield-driven**: content-rich
topics (economics, healthcare, labor) surface many qualifying op-eds per round; intrinsically
thinner, recency-gated topics (current_affairs, media, health-misinfo) surface fewer. Equal
input, unequal output.

`health` (Health Misinformation — anti-vax, wellness grift) and `healthcare` (the political
economy of for-profit medicine) are **intentionally distinct** categories, not a duplicate to
merge — see their descriptions in `categories.ts`.

## Why the obvious fix does not apply

A deficit-weighted `getBatch()` (pick the most under-represented categories each round) would
fix a *selection*-driven imbalance. It has no effect here because `--all` ignores `getBatch`
entirely. Balancing the `--all` path requires acting on **per-category yield within a round**,
not on which categories are chosen.

## Proposed mechanism — per-category soft cap (deficit-aware throttle)

Hook point: `main.ts`, where the per-round `categories` array is built (currently the `all`
branch at ~line 65), plus a per-category target passed into the researcher.

1. At round start, read the current corpus counts per category from `findings.json`
   (`countByCategory(): Record<string, number>`).
2. Compute each category's **deficit** against an even target:
   `target = totalSoFar / N`; `deficit[c] = target - count[c]` (negative ⇒ over-represented).
3. Convert deficit to a per-category **acceptance budget** for this round:
   - over-represented (`deficit < 0`): cap new entries low (e.g. `maxNew = 1`, or skip the
     category this round with probability proportional to how far over it is).
   - under-represented (`deficit > 0`): allow the normal/elevated budget (e.g. `maxNew = 4`).
   Clamp so a single round never swings the distribution violently.
4. Pass `maxNew` per category to the researcher/finder so it stops accepting once a category
   hits its round budget (it already produces a ranked list; just truncate per category).

This pulls the distribution toward even over successive rounds without ever *starving* a
category (thin categories keep their full budget; they simply can't catch the rich ones
instantly, which is correct — you cannot manufacture op-eds that do not exist).

Complexity: ~30–50 lines (a `countByCategory` helper + a deficit→budget function + threading
`maxNew` into the finder's per-category accept loop). Low risk, but it **changes live loop
behavior**, so gate it behind `PI_RESEARCH_CATEGORY_BALANCE=true` (default off) and enable it
only after the 1500 push, or for a dedicated re-balancing run.

## Alternative (simpler, post-hoc): targeted top-up runs

Instead of in-loop throttling, after reaching 1500 do a handful of **partial** runs that target
only the bottom-k categories: `tsx src/main.ts --batch-size k` seeded to the under-represented
set (current_affairs, media, health, race, immigration). This needs no code change beyond a
seed list and is the least invasive way to flatten the tail. Recommended as the first step;
promote to the in-loop mechanism only if drift recurs.
