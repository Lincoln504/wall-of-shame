/**
 * order.ts — deterministic, stable, category-interleaved ordering + pagination.
 *
 * Why deterministic: a generated share image hard-codes the page URL an entry
 * lives on (e.g. .../#/page/10). The order therefore must be reproducible across
 * loads. We key each entry's sort value off a hash of its STABLE id, not a
 * positional shuffle — so when the corpus grows (the agent adds entries toward
 * 1500), existing entries keep their relative order; a new entry just slots into
 * its hash position. (Absolute page numbers can still drift as the corpus grows,
 * but the order itself never randomly reshuffles.)
 *
 * Why interleaved: the raw data clusters by category (rounds add a category at a
 * time). An id-hash sort already mixes categories well; a light greedy de-cluster
 * pass then removes the occasional adjacent same-category pair.
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

/** The canonical, deterministic, category-interleaved order of all findings. */
export function canonicalOrder(findings: Finding[]): Finding[] {
  const sorted = findings
    .map(f => ({ f, k: stableKey(keyFor(f)) }))
    .sort((a, b) => a.k - b.k || (keyFor(a.f) < keyFor(b.f) ? -1 : 1))
    .map(x => x.f);
  return decluster(sorted);
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
