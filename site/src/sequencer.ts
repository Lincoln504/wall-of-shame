// sequencer.ts — the feed's next-entry selector.
//
// Pure, DOM-free, framework-free so it can be reasoned about and unit-tested in isolation.
// Goal (per product spec): a feed that feels MOSTLY random with a SMALL, randomized amount
// of consistency — never a locked rotation, never a filter bubble. Achieved by nudging
// per-candidate selection WEIGHTS (multiplicative biases), plus two hard run-length caps.
//
// Each axis (category, severity) is reasoned about INDEPENDENTLY:
//   • a mild "repeat penalty" so variety dominates but same-axis repeats still happen by chance
//     (that randomized recurrence IS the "inconsistent in its own application" the spec wants);
//   • severity additionally gets gentle inverse-frequency normalization, because the corpus is
//     ~77% medium — without it the feed would feel monotone. Category is near-uniform (top
//     share ~11%) so it needs no such correction;
//   • a hard cap: never more than MAX_RUN (3) of the same category in a row, and independently
//     never more than 3 of the same severity in a row;
//   • a dwell nudge: if the reader lingered on the entry just left, gently lift candidates that
//     share its category/severity for the NEXT pick only — a lean toward "more like that",
//     decaying immediately so it never compounds into a bubble.
// recentlySeen suppression avoids immediate repeats. Every weight stays > 0 (except the hard
// caps), so the draw can never deadlock on a real corpus, and degenerate pools relax gracefully.

import type { Finding } from './types.js';

export const TUNING = {
  MAX_RUN: 3,            // hard cap: max identical category OR severity in a row
  P_REPEAT_CAT: 0.5,     // weight multiplier when a candidate repeats the last category
  P_REPEAT_SEV: 0.6,     // weight multiplier when a candidate repeats the last severity
  SEV_INV_FREQ_ALPHA: 0.35, // gentle inverse-frequency lift for rare severities (high/low)
  RECENT_BUFFER: 20,     // ring buffer of recently-served ids to avoid near-repeats
  RECENT_PENALTY: 0.02,  // weight multiplier for a recently-seen candidate (near, not hard, exclude)
  DWELL_FLOOR_MS: 4000,  // below this: fast browsing, no affinity nudge
  DWELL_CEIL_MS: 25000,  // at/above this: clearly engaged, full affinity nudge
  DWELL_CAT_GAIN: 0.8,   // up to +80% weight on same-category candidates at max dwell
  DWELL_SEV_GAIN: 0.5,   // up to +50% weight on same-severity candidates at max dwell
};

type Rng = () => number;

// mulberry32 — small seedable PRNG so a session's feed isn't byte-identical across reloads
// but "prev" within a session stays exact. Seed is injected (see createSequencer).
function mulberry32(a: number): Rng {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface Sequencer {
  /** Pick the next entry. dwellMs = ms the reader spent on the entry just left (0 if none). */
  next(dwellMs?: number): Finding | null;
  /** Reset run/seen state (e.g. when the candidate pool changes). */
  reset(): void;
}

export function createSequencer(pool: Finding[], seed?: number): Sequencer {
  const rng: Rng = mulberry32((seed ?? 0x9e3779b9) >>> 0);

  // Inverse-frequency weight per severity value, precomputed once over the pool.
  // freq normalized to [0,1]; weight = (1/freq)^alpha, so rarer severities weigh more.
  const sevCount: Record<string, number> = {};
  for (const f of pool) sevCount[f.severity] = (sevCount[f.severity] || 0) + 1;
  const total = pool.length || 1;
  const sevInvWeight: Record<string, number> = {};
  for (const sev in sevCount) {
    const freq = sevCount[sev] / total;
    sevInvWeight[sev] = Math.pow(1 / freq, TUNING.SEV_INV_FREQ_ALPHA);
  }

  let last: Finding | null = null;
  let catRun = { cat: '', len: 0 };
  let sevRun = { sev: '', len: 0 };
  // Ring buffer of recently-served ids. Scaled down for tiny pools so it never starves the draw.
  const bufCap = Math.max(1, Math.min(TUNING.RECENT_BUFFER, Math.floor(pool.length / 2)));
  let recent: string[] = [];
  const recentSet = new Set<string>();

  const idOf = (f: Finding) => f.id || f.url;

  function pushRecent(f: Finding) {
    const id = idOf(f);
    recent.push(id);
    recentSet.add(id);
    while (recent.length > bufCap) {
      const ev = recent.shift()!;
      if (!recent.includes(ev)) recentSet.delete(ev);
    }
  }

  function weights(dwellMs: number, capCat: boolean, capSev: boolean, useRecent: boolean): number[] {
    const aff = clamp01((dwellMs - TUNING.DWELL_FLOOR_MS) / (TUNING.DWELL_CEIL_MS - TUNING.DWELL_FLOOR_MS));
    const out = new Array<number>(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let w = 1;

      // Hard run-length caps (the only hard rule). A capped axis zeroes matching candidates.
      if (capCat && catRun.len >= TUNING.MAX_RUN && c.category === catRun.cat) { out[i] = 0; continue; }
      if (capSev && sevRun.len >= TUNING.MAX_RUN && c.severity === sevRun.sev) { out[i] = 0; continue; }

      // Recently-seen suppression (soft).
      if (useRecent && recentSet.has(idOf(c))) w *= TUNING.RECENT_PENALTY;

      // Independent variety-vs-consistency biases.
      if (last) {
        if (c.category === last.category) w *= TUNING.P_REPEAT_CAT;
        if (c.severity === last.severity) w *= TUNING.P_REPEAT_SEV;
      }

      // Severity inverse-frequency normalization (severity axis only).
      w *= sevInvWeight[c.severity] ?? 1;

      // Dwell-time affinity nudge (last dwell only; decays next pick).
      if (aff > 0 && last) {
        if (c.category === last.category) w *= 1 + aff * TUNING.DWELL_CAT_GAIN;
        if (c.severity === last.severity) w *= 1 + aff * TUNING.DWELL_SEV_GAIN;
      }

      out[i] = w;
    }
    return out;
  }

  function draw(w: number[]): number {
    let sum = 0;
    for (const x of w) sum += x;
    if (sum <= 0) return -1;
    let r = rng() * sum;
    for (let i = 0; i < w.length; i++) {
      r -= w[i];
      if (r < 0) return i;
    }
    return w.length - 1; // float-rounding fallback
  }

  function next(dwellMs = 0): Finding | null {
    if (pool.length === 0) return null;
    if (pool.length === 1) { last = pool[0]; return pool[0]; }

    // Try full constraints, then relax in order so the draw can never deadlock on a
    // degenerate pool (single category / single severity / all recently-seen):
    //   1. full  2. drop severity cap  3. drop both caps  4. drop caps + recently-seen.
    let idx = -1;
    const attempts: Array<[boolean, boolean, boolean]> = [
      [true, true, true],
      [true, false, true],
      [false, false, true],
      [false, false, false],
    ];
    for (const [capCat, capSev, useRecent] of attempts) {
      idx = draw(weights(dwellMs, capCat, capSev, useRecent));
      if (idx >= 0) break;
    }
    if (idx < 0) idx = Math.floor(rng() * pool.length); // absolute last resort

    const picked = pool[idx];

    // Update run-length state (independent axes).
    catRun = picked.category === catRun.cat ? { cat: catRun.cat, len: catRun.len + 1 } : { cat: picked.category, len: 1 };
    sevRun = picked.severity === sevRun.sev ? { sev: sevRun.sev, len: sevRun.len + 1 } : { sev: picked.severity, len: 1 };
    pushRecent(picked);
    last = picked;
    return picked;
  }

  function reset() {
    last = null;
    catRun = { cat: '', len: 0 };
    sevRun = { sev: '', len: 0 };
    recent = [];
    recentSet.clear();
  }

  return { next, reset };
}
