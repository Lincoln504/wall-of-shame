/**
 * telemetry.ts — audit instrumentation for the Wall of Shame agent.
 *
 * Wall of Shame doubles as a real-world test/audit harness for the pi-research
 * tool: every round exercises the SDK end-to-end (init -> multi-source research
 * -> scrape -> synthesis -> extraction -> review -> stealth verification) across
 * 13 adversarial topics. This module captures granular, timestamped telemetry —
 * per-stage durations, success/failure rates, yield, and an error taxonomy — and
 * writes a structured JSON audit artifact per run to agent/data/runs/.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { ResearchStats } from '@lincoln504/pi-research';

export interface CategoryTelemetry {
  key: string;
  name: string;
  ok: boolean;
  error?: string;
  /** stage that failed, if any: 'research' | 'review' | 'merge' */
  failedStage?: string;
  researchMs: number;
  reviewMs: number;
  mergeMs: number;
  totalMs: number;
  candidates: number;      // structured findings extracted (deepseek)
  reviewed: number;        // findings approved by the reviewer (gemma)
  added: number;           // net-new findings written to the wall
  duplicates: number;      // skipped: already seen / on the wall
  failedVerify: number;    // skipped: stealth-browser existence check failed
  invalid: number;         // skipped: non-http / malformed URL
}

export interface MergeStats {
  duplicates: number;
  failedVerify: number;
  invalid: number;
}

export interface RunTelemetry {
  runId: string;
  mode: 'discovery' | 'seed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  concurrency: number;
  categoryCount: number;
  totalFindingsAfter: number;
  /** pi-research's own internal telemetry for this round (the tool under audit):
   *  researchers launched, searches, URLs analyzed/failed, tokens, cost, tool usage. */
  piResearch: ResearchStats | null;
  categories: CategoryTelemetry[];
  totals: {
    added: number;
    duplicates: number;
    failedVerify: number;
    invalid: number;
    candidates: number;
    reviewed: number;
    errors: number;
  };
  rates: {
    /** categories whose research stage produced a usable report */
    researchSuccess: number;
    /** categories whose review stage completed without error */
    reviewSuccess: number;
    /** reviewed findings that passed stealth verification (added / (added+failedVerify)) */
    verificationPass: number;
    /** categories that completed the full pipeline without error */
    categorySuccess: number;
    /** added / candidates — end-to-end yield of the tool */
    extractionYield: number;
  };
}

const pct = (num: number, den: number): number =>
  den <= 0 ? 0 : Math.round((num / den) * 1000) / 10;

/** Assemble a RunTelemetry snapshot and compute rates. */
export function buildRunTelemetry(input: {
  runId: string;
  mode: 'discovery' | 'seed';
  startedAt: number;
  finishedAt: number;
  concurrency: number;
  totalFindingsAfter: number;
  categories: CategoryTelemetry[];
  piResearch?: ResearchStats | null;
}): RunTelemetry {
  const cats = input.categories;
  const sum = (f: (c: CategoryTelemetry) => number) => cats.reduce((a, c) => a + f(c), 0);

  const totals = {
    added: sum(c => c.added),
    duplicates: sum(c => c.duplicates),
    failedVerify: sum(c => c.failedVerify),
    invalid: sum(c => c.invalid),
    candidates: sum(c => c.candidates),
    reviewed: sum(c => c.reviewed),
    errors: cats.filter(c => !c.ok).length,
  };

  const researchOk = cats.filter(c => c.failedStage !== 'research' && (c.candidates > 0 || c.reviewed > 0 || c.ok)).length;
  const reviewOk = cats.filter(c => c.failedStage !== 'review' && c.failedStage !== 'research' && c.ok || c.reviewed > 0).length;
  const verifyDen = totals.added + totals.failedVerify;

  return {
    runId: input.runId,
    mode: input.mode,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: input.finishedAt - input.startedAt,
    concurrency: input.concurrency,
    categoryCount: cats.length,
    totalFindingsAfter: input.totalFindingsAfter,
    piResearch: input.piResearch ?? null,
    categories: cats,
    totals,
    rates: {
      researchSuccess: pct(researchOk, cats.length),
      reviewSuccess: pct(reviewOk, cats.length),
      verificationPass: pct(totals.added, verifyDen),
      categorySuccess: pct(cats.filter(c => c.ok).length, cats.length),
      extractionYield: pct(totals.added, totals.candidates),
    },
  };
}

/** Write the audit artifact to agent/data/runs/run-<runId>.json. */
export function writeRunReport(t: RunTelemetry, dataDir: string): string {
  const runsDir = join(dataDir, 'runs');
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
  const path = join(runsDir, `run-${t.runId}.json`);
  writeFileSync(path, JSON.stringify(t, null, 2), 'utf-8');
  return path;
}

const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;

/** Emit a verbose, human-readable audit summary through the provided logger. */
export function logRunSummary(t: RunTelemetry, log: (msg: string) => void): void {
  log('════════════════ PI-RESEARCH AUDIT — RUN SUMMARY ════════════════');
  log(`run ${t.runId} | mode=${t.mode} | ${t.startedAt} → ${t.finishedAt} (${ms(t.durationMs)})`);
  log(`categories=${t.categoryCount} concurrency=${t.concurrency} | wall total=${t.totalFindingsAfter}`);
  log('── pipeline rates (pi-research tool health) ──');
  log(`  research success : ${t.rates.researchSuccess}%   review success: ${t.rates.reviewSuccess}%`);
  log(`  verification pass: ${t.rates.verificationPass}%   category success: ${t.rates.categorySuccess}%`);
  log(`  extraction yield : ${t.rates.extractionYield}% (added/candidates)`);
  log('── totals ──');
  log(`  candidates=${t.totals.candidates} reviewed=${t.totals.reviewed} added=${t.totals.added} `
    + `dup=${t.totals.duplicates} failVerify=${t.totals.failedVerify} invalid=${t.totals.invalid} errors=${t.totals.errors}`);
  if (t.piResearch) {
    const p = t.piResearch;
    log('── pi-research internals (tool under audit) ──');
    log(`  researchers=${p.researchersLaunched} rounds=${p.roundsCompleted} searchQueries=${p.searchQueries} `
      + `urlsDiscovered=${p.urlsDiscovered} urlsAnalyzed=${p.urlsAnalyzed} urlsFailed=${p.urlsFailed}`);
    log(`  fetchSuccess=${p.fetchSuccess} browserSuccess=${p.browserSuccess} browserFallbacks=${p.browserFallbacks} `
      + `errors=${p.errors} tokens=${p.tokens} cost=$${(p.cost ?? 0).toFixed?.(4) ?? p.cost}`);
  }
  log('── per category ──');
  for (const c of t.categories) {
    const status = c.ok ? 'ok ' : `ERR(${c.failedStage})`;
    log(`  ${c.key.padEnd(12)} ${status.padEnd(9)} +${c.added} `
      + `(cand=${c.candidates} rev=${c.reviewed} dup=${c.duplicates} failV=${c.failedVerify}) `
      + `research=${ms(c.researchMs)} review=${ms(c.reviewMs)} total=${ms(c.totalMs)}`
      + (c.error ? `  ← ${c.error.slice(0, 80)}` : ''));
  }
  log('═════════════════════════════════════════════════════════════════');
}
