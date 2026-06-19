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
//   • HARD no-repeat within a session: every card drawn this page-load is recorded in a
//     session-scoped "served" set and excluded from all future draws, so a reader swiping/
//     clicking through the feed never sees the same card twice — until a (filtered) pool is
//     genuinely exhausted, at which point the draw relaxes and allows repeats rather than
//     deadlocking. The set is module-level, so it persists across filter changes and the
//     search/entry round-trip; only a real page reload starts a fresh no-repeat session.
// State is minimal and in-memory only (a rolling average read-time + a small per-category score).
// Every non-excluded weight stays > 0, so the draw can't deadlock and degenerate pools relax.

import type { Finding } from './types.js';

// Session ("one page load") scope: ids of every card served this session. Module-level so it
// outlives any single sequencer instance — a filter change builds a new sequencer for the new
// pool, but they all share this set, so a card seen under one filter won't reappear under another.
const sessionServed = new Set<string>();

export const TUNING = {
  MAX_RUN: 3,            // hard cap: max identical category OR severity in a row
  P_REPEAT_CAT: 0.5,     // weight multiplier when a candidate repeats the last category
  P_REPEAT_SEV: 0.6,     // weight multiplier when a candidate repeats the last severity
  P_REPEAT_DOMAIN: 0.25, // weight multiplier when a candidate repeats the last source domain
  SEV_INV_FREQ_ALPHA: 0.35, // gentle inverse-frequency lift for rare severities (high/low)
  // Read-time → category affinity. Engagement is RELATIVE to the reader's own rolling pace, so
  // "a good amount longer than others" — not a fixed seconds threshold — is what counts.
  DWELL_AVG_ALPHA: 0.3,    // EMA weight folding each read-time into the rolling average pace
  DWELL_MIN_AVG_MS: 1500,  // floor on the comparison baseline (avoids a tiny avg flagging everything)
  AFFINITY_DECAY: 0.6,     // per-pick decay of a category's affinity → a boost lasts ≈3 picks
  AFFINITY_CAP: 3,         // cap accumulated affinity per category (no runaway)
  AFFINITY_GAIN: 9,        // weight multiplier per unit of affinity
  AFFINITY_BOOST_MAX: 26,  // cap a candidate's affinity weight multiplier
  // Category coverage. Guarantees a long browse surfaces EVERY category, not just the high-yield
  // ones: each category tracks how many steps since it last appeared ("gap"). A soft boost lifts a
  // category's weight once its gap exceeds COVERAGE_SOFT_FRAC × (number of live categories), ramping
  // with the gap; and a HARD backstop force-restricts the draw to any category whose gap reaches the
  // live-category count — so no category waits longer than ~that many steps. The window is the live
  // category count itself (you can't show C categories in fewer than C steps), and it shrinks as
  // categories exhaust, so coverage stays tight. Soft boost usually satisfies it before the backstop.
  COVERAGE_SOFT_FRAC: 0.45, // gap fraction (× live-cat count) at which the soft boost starts
  COVERAGE_GAIN: 1.5,       // per-step soft lift for an overdue category (ramps with the gap)
  COVERAGE_BOOST_MAX: 24,   // cap the soft coverage multiplier (keeps it from fully erasing randomness)
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
  /** Record a finding as served this session (for a card chosen OUTSIDE next() — e.g. the feed's
   *  preferred first card — so it's never re-drawn). next() marks its own picks automatically. */
  markServed(f: Finding): void;
  /** Reset per-instance run + engagement state. Does NOT clear the session-wide served set
   *  (no-repeat is intended to span the whole page-load session). */
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
  // Coverage bookkeeping: a monotonic step counter and the step at which each category last appeared.
  let step = 0;
  const catLastShown: Record<string, number> = {};
  const NEVER = -1e9; // gap for a category never shown this session → maximally overdue

  // Categories that still have at least one unshown (not-yet-served) entry — the set coverage
  // must cycle through. Shrinks as categories exhaust, tightening the guarantee window.
  function liveCategories(): Set<string> {
    const s = new Set<string>();
    for (const c of pool) if (!sessionServed.has(idOf(c))) s.add(c.category);
    return s;
  }

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
  const idOf = (f: Finding) => f.id || f.url;

  // `useServed` ON = hard-exclude every card already served this session (the no-repeat guarantee);
  // OFF is the exhaustion fallback (pool fully seen) so the draw never deadlocks. `restrict` (the
  // hard coverage backstop) limits the draw to candidates of overdue categories; null = no limit.
  // `softStart` is the gap beyond which the soft coverage boost applies.
  function weights(capCat: boolean, capSev: boolean, useServed: boolean, restrict: Set<string> | null, softStart: number): number[] {
    const out = new Array<number>(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let w = 1;

      // HARD no-repeat: a card already served this session is removed from the draw entirely.
      if (useServed && sessionServed.has(idOf(c))) { out[i] = 0; continue; }
      // HARD coverage backstop: when categories are critically overdue, only they are eligible.
      if (restrict && !restrict.has(c.category)) { out[i] = 0; continue; }

      // Hard run-length caps. A capped axis zeroes matching candidates.
      if (capCat && catRun.len >= TUNING.MAX_RUN && c.category === catRun.cat) { out[i] = 0; continue; }
      if (capSev && sevRun.len >= TUNING.MAX_RUN && c.severity === sevRun.sev) { out[i] = 0; continue; }

      // Independent variety-vs-consistency biases. The category repeat-penalty is suspended for
      // a category the reader is actively engaged with (has affinity) — there we WANT recurrence,
      // so the penalty shouldn't fight the read-time boost.
      if (last) {
        if (c.category === last.category && !((catAff[c.category] ?? 0) > 0)) w *= TUNING.P_REPEAT_CAT;
        if (c.severity === last.severity) w *= TUNING.P_REPEAT_SEV;
        // Source diversity: discourage two entries from the same domain back-to-back (soft, so it
        // relaxes when a domain dominates a tiny filtered pool). Guarded on a real domain string.
        if (last.domain && c.domain === last.domain) w *= TUNING.P_REPEAT_DOMAIN;
      }

      // Severity inverse-frequency normalization (severity axis only).
      w *= sevInvWeight[c.severity] ?? 1;

      // Read-time affinity: lift categories the reader has been dwelling on (relative to their
      // own pace). Persists/decays across picks, so the lift spans the next few picks.
      const ca = catAff[c.category] ?? 0;
      if (ca > 0) w *= 1 + Math.min(TUNING.AFFINITY_BOOST_MAX, ca * TUNING.AFFINITY_GAIN);

      // Coverage soft boost: the longer a category has gone unshown past softStart, the more its
      // weight is lifted — so overdue categories surface on their own, usually before the hard
      // backstop is ever needed. Never-shown categories (gap ≈ NEVER→huge) get the capped max.
      const gap = step - (catLastShown[c.category] ?? NEVER);
      if (gap > softStart) w *= 1 + Math.min(TUNING.COVERAGE_BOOST_MAX, TUNING.COVERAGE_GAIN * (gap - softStart));

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
    if (pool.length === 1) { last = pool[0]; sessionServed.add(idOf(pool[0])); catLastShown[pool[0].category] = ++step; return pool[0]; }

    step++;
    // Coverage window = the number of live categories (can't cover C categories in fewer than C
    // steps). Any live category whose gap has reached the window is "overdue" → the hard backstop
    // restricts the draw to overdue categories, guaranteeing none waits much longer than the window.
    const live = liveCategories();
    const window = Math.max(1, live.size);
    const softStart = Math.floor(window * TUNING.COVERAGE_SOFT_FRAC);
    const overdue = new Set<string>();
    for (const cat of live) if (step - (catLastShown[cat] ?? NEVER) >= window) overdue.add(cat);
    const forced = overdue.size ? overdue : null;

    // Relax in order so the draw can never deadlock:
    //   1-3. coverage backstop + no-repeat, dropping the run caps   4. drop the coverage restriction
    //   (overdue cats all served)   5. drop no-repeat too — only once the pool is fully exhausted.
    let idx = -1;
    const attempts: Array<[boolean, boolean, boolean, Set<string> | null]> = [
      [true, true, true, forced],
      [true, false, true, forced],
      [false, false, true, forced],
      [false, false, true, null],
      [false, false, false, null],
    ];
    for (const [capCat, capSev, useServed, restrict] of attempts) {
      idx = draw(weights(capCat, capSev, useServed, restrict, softStart));
      if (idx >= 0) break;
    }
    if (idx < 0) idx = Math.floor(rng() * pool.length); // absolute last resort

    const picked = pool[idx];

    // Update run-length state (independent axes), record as served (no-repeat), and stamp coverage.
    catRun = picked.category === catRun.cat ? { cat: catRun.cat, len: catRun.len + 1 } : { cat: picked.category, len: 1 };
    sevRun = picked.severity === sevRun.sev ? { sev: sevRun.sev, len: sevRun.len + 1 } : { sev: picked.severity, len: 1 };
    sessionServed.add(idOf(picked));
    catLastShown[picked.category] = step;
    last = picked;
    return picked;
  }

  function markServed(f: Finding) {
    if (f) sessionServed.add(idOf(f));
  }

  function reset() {
    last = null;
    catRun = { cat: '', len: 0 };
    sevRun = { sev: '', len: 0 };
    avgDwell = 0;
    step = 0;
    for (const k in catAff) delete catAff[k];
    for (const k in catLastShown) delete catLastShown[k];
  }

  return { next, markServed, reset };
}
