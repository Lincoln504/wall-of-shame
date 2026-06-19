/**
 * order.ts — deterministic, stable, category-interleaved ordering + pagination.
 *
 * This is THE single default list order: newest arrival batch on top, shuffled and
 * de-clustered within each batch (no same-category run), and every entry locked in
 * place once it lands — see canonicalOrder() below. New rounds prepend on top of the
 * frozen older entries.
 *
 * Why it stays stable across loads and growth: each entry's batch is fixed by its
 * immutable foundAt and its within-batch position by a hash of its STABLE id — no
 * clock-based or positional randomness. So a new round forms a new top batch and
 * prepends without disturbing any existing entry's position. Share links are id-based
 * permalinks (/entry/<id>) resolved to whatever page the entry currently sits on, so
 * reordering as the corpus grows toward 1500 never rots a shared link — page numbers
 * are never embedded in a share URL.
 *
 * Why de-clustered: the raw data clusters by category (a round merges a category at a
 * time, so a batch arrives as same-category runs). The id-hash shuffle mixes them and
 * a light greedy de-cluster pass removes any remaining adjacent same-category pair.
 */

import type { Finding } from './types.js';

export const PAGE_SIZE = 12;

// xmur3 string-hash → 32-bit seed.
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

// mulberry32 seeded PRNG → uniform float in [0, 1).
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable pseudo-random sort key in [0, 1), fixed by the entry's identity. */
function stableKey(id: string): number {
  return mulberry32(xmur3(id)())();
}

function keyFor(f: Finding): string {
  return f.id || f.url || f.title;
}

/** Stable identity "shuffle": order a set by a hash of each entry's id. Deterministic
 *  (no clock, no positional randomness), so the same set always yields the same order. */
function stableHashOrder(arr: Finding[]): Finding[] {
  return arr
    .map(f => ({ f, k: stableKey(keyFor(f)) }))
    .sort((a, b) => a.k - b.k || (keyFor(a.f) < keyFor(b.f) ? -1 : 1))
    .map(x => x.f);
}

// Arrivals whose foundAt differ by more than this belong to different batches.
// Chosen well BELOW the inter-round gap (rounds complete minutes apart) so a new
// round always forms its own NEW batch and never merges backward into an existing
// one — that is what keeps already-placed entries locked. A single slow round may
// split into adjacent sub-batches; harmless (each is still de-clustered and stable).
const BATCH_GAP_MS = 90_000;

/**
 * Greedy de-cluster: never place two adjacent entries of the same category when a
 * different-category entry remains. Deterministic — depends only on input order.
 */
function decluster(arr: Finding[]): Finding[] {
  const pool = arr.slice();
  const out: Finding[] = [];
  while (pool.length) {
    let idx = 0;
    if (out.length) {
      const lastCat = out[out.length - 1].category;
      if (pool[0].category === lastCat) {
        const alt = pool.findIndex(x => x.category !== lastCat);
        if (alt !== -1) idx = alt;
      }
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * The canonical list order: newest arrival batch on top, de-clustered within each
 * batch, every entry locked once placed.
 *
 *   1. Sort all entries newest-first by foundAt.
 *   2. Partition into arrival batches on foundAt gaps (a round's worth of entries
 *      that came in together).
 *   3. Within EACH batch independently: stable identity shuffle, then a greedy
 *      de-cluster so no two same-category entries sit adjacent.
 *   4. Concatenate batches newest → oldest.
 *
 * Stability ("locked in place"): a batch is de-clustered using ONLY its own members,
 * and both a member's batch (its foundAt) and its within-batch position (its id hash)
 * are immutable. So when the agent adds a new round, that round forms a NEW top batch
 * and prepends — no existing entry changes position. New arrivals are shuffled (no
 * same-category run) and stack on top of the locked older ones.
 */
export function canonicalOrder(findings: Finding[]): Finding[] {
  const byTimeDesc = [...findings].sort((a, b) => (b.foundAt || '').localeCompare(a.foundAt || ''));

  const batches: Finding[][] = [];
  let cur: Finding[] = [];
  let prevT: number | null = null;
  for (const f of byTimeDesc) {
    const t = Date.parse(f.foundAt || '') || 0;
    if (prevT !== null && prevT - t > BATCH_GAP_MS) { batches.push(cur); cur = []; }
    cur.push(f);
    prevT = t;
  }
  if (cur.length) batches.push(cur);

  return batches.flatMap(b => decluster(stableHashOrder(b)));
}

export function totalPages(count: number): number {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

/** 1-based page number for a 0-based index in the canonical order. */
export function pageForIndex(index: number): number {
  return Math.floor(index / PAGE_SIZE) + 1;
}

/** Clamp a (possibly out-of-range / NaN) page number to [1, totalPages]. */
export function clampPage(page: number, count: number): number {
  const tp = totalPages(count);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.floor(page), tp);
}

/** The slice of entries shown on a 1-based page. */
export function pageSlice<T>(items: T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}
