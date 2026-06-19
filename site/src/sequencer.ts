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
//   • a read-time affinity: reading an entry a good amount LONGER THAN THE READER'S OWN PACE
//     (relative, not a fixed seconds threshold) lifts that CATEGORY's weight for the upcoming
//     picks. The boost decays each pick (≈3-pick half-life) so it stays elevated only while
//     engagement with that category stays high, and fades on its own otherwise — never a bubble.
//     Affinity is built from the dwell on the entry just left, attributed to THAT entry's
//     category (passed in by the caller), so it can never apply to the first card.
// State is minimal and in-memory only (a rolling average read-time + a small per-category score),
// reset whenever the pool changes. recentlySeen suppression avoids immediate repeats. Every weight
// stays > 0 (except the hard caps), so the draw can't deadlock and degenerate pools relax gracefully.

import type { Finding } from './types.js';

export const TUNING = {
  MAX_RUN: 3,            // hard cap: max identical category OR severity in a row
  P_REPEAT_CAT: 0.5,     // weight multiplier when a candidate repeats the last category
  P_REPEAT_SEV: 0.6,     // weight multiplier when a candidate repeats the last severity
  SEV_INV_FREQ_ALPHA: 0.35, // gentle inverse-frequency lift for rare severities (high/low)
  RECENT_BUFFER: 20,     // ring buffer of recently-served ids to avoid near-repeats
  RECENT_PENALTY: 0.02,  // weight multiplier for a recently-seen candidate (near, not hard, exclude)
  // Read-time → category affinity. Engagement is RELATIVE to the reader's own rolling pace, so
  // "a good amount longer than others" — not a fixed seconds threshold — is what counts.
  DWELL_AVG_ALPHA: 0.3,    // EMA weight folding each read-time into the rolling average pace
  DWELL_MIN_AVG_MS: 1500,  // floor on the comparison baseline (avoids a tiny avg flagging everything)
  AFFINITY_DECAY: 0.55,    // per-pick decay of a category's affinity → a boost lasts ≈3 picks
  AFFINITY_CAP: 3,         // cap accumulated affinity per category (no runaway)
  AFFINITY_GAIN: 5,        // weight multiplier per unit of affinity
  AFFINITY_BOOST_MAX: 14,  // cap a candidate's affinity weight multiplier
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

export interface Sequencer {
  /**
   * Pick the next entry. `dwellMs` = ms the reader spent on the entry just left (0 if none);
   * `leftCategory` = that entry's category, so the read-time affinity is credited to what was
   * actually read (the feed uses a lookahead, so the sequencer's own last pick isn't it).
   */
  next(dwellMs?: number, leftCategory?: string): Finding | null;
  /** Reset run/seen + engagement state (e.g. when the candidate pool changes). */
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
  // Engagement model (minimal, in-memory): a rolling average read-time (the reader's own pace)
  // and a small per-category affinity score. A read meaningfully longer than the rolling average
  // boosts that category; all affinities decay each pick so a boost lasts ≈3 picks unless renewed.
  let avgDwell = 0;
  const catAff: Record<string, number> = {};

  function updateAffinity(dwellMs: number, cat: string | undefined) {
    // Decay every category each step (a boost fades unless the reader keeps engaging with it).
    for (const k in catAff) { catAff[k] *= TUNING.AFFINITY_DECAY; if (catAff[k] < 0.02) delete catAff[k]; }
    // Compare to the reader's PRIOR pace (before folding in this read) so a long read isn't
    // diluted by its own value. The very first read just sets the baseline (ratio ≈ 1 → no boost).
    const baseAvg = avgDwell > 0 ? avgDwell : dwellMs;
    if (cat && baseAvg > 0) {
      const ratio = dwellMs / Math.max(TUNING.DWELL_MIN_AVG_MS, baseAvg);
      if (ratio > 1) catAff[cat] = Math.min(TUNING.AFFINITY_CAP, (catAff[cat] || 0) + (ratio - 1));
    }
    avgDwell = avgDwell > 0 ? avgDwell * (1 - TUNING.DWELL_AVG_ALPHA) + dwellMs * TUNING.DWELL_AVG_ALPHA : dwellMs;
  }
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

  function weights(capCat: boolean, capSev: boolean, useRecent: boolean): number[] {
    const out = new Array<number>(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let w = 1;

      // Hard run-length caps (the only hard rule). A capped axis zeroes matching candidates.
      if (capCat && catRun.len >= TUNING.MAX_RUN && c.category === catRun.cat) { out[i] = 0; continue; }
      if (capSev && sevRun.len >= TUNING.MAX_RUN && c.severity === sevRun.sev) { out[i] = 0; continue; }

      // Recently-seen suppression (soft).
      if (useRecent && recentSet.has(idOf(c))) w *= TUNING.RECENT_PENALTY;

      // Independent variety-vs-consistency biases. The category repeat-penalty is suspended for
      // a category the reader is actively engaged with (has affinity) — there we WANT recurrence,
      // so the penalty shouldn't fight the read-time boost.
      if (last) {
        if (c.category === last.category && !((catAff[c.category] ?? 0) > 0)) w *= TUNING.P_REPEAT_CAT;
        if (c.severity === last.severity) w *= TUNING.P_REPEAT_SEV;
      }

      // Severity inverse-frequency normalization (severity axis only).
      w *= sevInvWeight[c.severity] ?? 1;

      // Read-time affinity: lift categories the reader has been dwelling on (relative to their
      // own pace). Persists/decays across picks, so the lift spans the next few picks.
      const ca = catAff[c.category] ?? 0;
      if (ca > 0) w *= 1 + Math.min(TUNING.AFFINITY_BOOST_MAX, ca * TUNING.AFFINITY_GAIN);

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

  function next(dwellMs = 0, leftCategory?: string): Finding | null {
    // Fold the read just finished into the engagement model BEFORE drawing (attributed to the
    // entry actually left). dwellMs 0 (seed/first picks) is a no-op, so affinity never applies
    // to the first card.
    if (dwellMs > 0) updateAffinity(dwellMs, leftCategory ?? last?.category);

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
      idx = draw(weights(capCat, capSev, useRecent));
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
    avgDwell = 0;
    for (const k in catAff) delete catAff[k];
  }

  return { next, reset };
}
