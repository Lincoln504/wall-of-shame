/**
 * run.ts — the single shared round-runner for the Wall of Shame agent.
 *
 * Both the batch entry point (main.ts) and the interactive menu (cli.ts) call
 * runRound() / runSeedRound() so there is exactly ONE definition of how a round
 * behaves (dedup, query-history, commit, cursor advancement).
 *
 * Two round types share one engine:
 *   - runRound()      — DISCOVERY: general web-search research per category, then
 *                       review. This is the steady-state lifecycle.
 *   - runSeedRound()  — SEED RE-EVALUATION: directly evaluate the curated legacy
 *                       URL list (no general search). Used to bring the existing
 *                       saved links back onto the wall quickly.
 *
 * Concurrency model (chosen for robust failure isolation, not raw speed):
 *   Phase 1 — per-category work runs CONCURRENTLY, bounded by `concurrency`, each
 *             category fully isolated (a crash in one never aborts the others).
 *             Side-effect free w.r.t. shared store/state.
 *   Phase 2 — a SEQUENTIAL fan-in merges each category's reviewed findings into
 *             the shared store/state (global dedup + stealth verification), saving
 *             atomically after each category so a mid-round crash keeps progress.
 *   Commit  — a single git commit/push at the end (no per-category commit races).
 */

import type { Category } from './types.js';
import { CATEGORY_COUNT } from './categories.js';
import {
  loadFindings, saveFindings, loadState, saveState, addFindings, DATA_DIR,
  type RawFinding, type FindingsStore, type RunState,
} from './findings.js';
import { getSessionMetrics, extractRunStats } from '@lincoln504/pi-research';
import { runResearch, initializeResearch } from './researcher.js';
import { runReview } from './reviewer.js';
import { groundFindings } from './verify.js';
import { getLegacySeeds } from './legacy.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush } from './git.js';
import { mapWithConcurrency } from './utils.js';
import {
  buildRunTelemetry, writeRunReport, logRunSummary,
  type CategoryTelemetry, type RunTelemetry,
} from './telemetry.js';

const RESEARCH_ATTEMPTS = 2;
const REVIEW_ATTEMPTS = 2;
const RETRY_DELAY_MS = 5000;

export interface RoundOptions {
  /** Categories to process this round. */
  categories: Category[];
  /** Max categories worked on at once. */
  concurrency: number;
  log: (msg: string) => void;
  /** Commit & push the result at the end of the round. Default true. */
  commit?: boolean;
  /** Persistent cursor start, used to advance run-state.categoryIndex. */
  startIndex?: number;
}

export interface CategoryOutcome {
  key: string;
  name: string;
  added: number;
  error?: string;
}

export interface RoundResult {
  totalAdded: number;
  errors: number;
  perCategory: CategoryOutcome[];
  totalFindings: number;
  telemetry: RunTelemetry;
  reportPath: string;
}

interface ReviewedBundle {
  reviewed: RawFinding[];
  queries: string[];
  /** audit telemetry from phase 1 */
  researchMs: number;
  reviewMs: number;
  candidates: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Review extracted findings (or a raw report) with bounded retries. */
async function reviewWithRetries(
  catKey: string,
  input: RawFinding[] | string,
  log: (msg: string) => void,
  context?: string,
): Promise<RawFinding[]> {
  const empty = Array.isArray(input) ? input.length === 0 : !input;
  if (empty) {
    log(`  [warn] ${catKey}: nothing to review`);
    return [];
  }
  for (let attempt = 1; attempt <= REVIEW_ATTEMPTS; attempt++) {
    try {
      return await runReview(input, log, context);
    } catch (err) {
      log(`  [error] ${catKey} review attempt ${attempt}/${REVIEW_ATTEMPTS} failed: ${String(err)}`);
      if (attempt === REVIEW_ATTEMPTS) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
  return [];
}

/** Phase-1 work for DISCOVERY: research+extract (retried) then review (retried). */
async function researchAndReview(
  cat: Category,
  store: FindingsStore,
  state: RunState,
  log: (msg: string) => void,
): Promise<ReviewedBundle> {
  let findings: RawFinding[] = [];
  let report = '';
  let queries: string[] = [];

  const researchStart = Date.now();
  for (let attempt = 1; attempt <= RESEARCH_ATTEMPTS; attempt++) {
    try {
      const catHistory = state.queryHistory[cat.key] || {};
      const result = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, store, state, log);
      findings = result.findings;
      report = result.rawReport || '';
      queries = result.queries;
      break;
    } catch (err) {
      log(`  [error] ${cat.key} research attempt ${attempt}/${RESEARCH_ATTEMPTS} failed: ${String(err)}`);
      if (attempt === RESEARCH_ATTEMPTS) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
  const researchMs = Date.now() - researchStart;

  // Golden flow: the reviewer audits the extracted findings, grounded in the raw
  // research report (desk-audit context). If extraction produced nothing, fall
  // back to letting the reviewer mine the raw report directly.
  const reviewInput: RawFinding[] | string = findings.length > 0 ? findings : report;
  const reviewContext = findings.length > 0 ? report : undefined;
  const reviewStart = Date.now();
  const reviewed = await reviewWithRetries(cat.key, reviewInput, log, reviewContext);
  // Option B grounding: verify each reviewed finding against its real article text
  // (re-scraped with pi-research's two-layer scraper). On by default; WOS_GROUND_VERIFY=0
  // skips it. Never throws — falls back to the desk-audited finding per item.
  const grounded = process.env['WOS_GROUND_VERIFY'] === '0'
    ? reviewed
    : await groundFindings(reviewed, log);
  return { reviewed: grounded, queries, researchMs, reviewMs: Date.now() - reviewStart, candidates: findings.length };
}

/**
 * Phase-1 work for SEED mode: research a category seeded by its curated legacy
 * URLs, then extract + review. The reviewer no longer has a web tool, so seeds
 * can't be "read" by the reviewer directly — instead runResearch() injects this
 * category's legacy links as `initialLinks`, so the gemma research stage actually
 * scrapes them and the same extract→review pipeline produces grounded findings.
 * Categories with no legacy seeds are skipped (this is what makes seed mode
 * distinct from full discovery).
 */
async function evaluateSeeds(
  cat: Category,
  store: FindingsStore,
  state: RunState,
  log: (msg: string) => void,
): Promise<ReviewedBundle> {
  const seeds = getLegacySeeds(cat.key);
  if (seeds.length === 0) {
    log(`  [seed] ${cat.key}: no legacy seeds — skipping`);
    return { reviewed: [], queries: [], researchMs: 0, reviewMs: 0, candidates: 0 };
  }
  log(`  [seed] ${cat.key}: research seeded by ${seeds.length} curated links`);
  return researchAndReview(cat, store, state, log);
}

/**
 * Phase 2: sequentially merge each category's reviewed findings into the shared
 * store/state, saving atomically per category, then a single fan-in commit.
 */
async function mergeAndPersist(
  categories: Category[],
  settled: Array<{ ok: true; value: ReviewedBundle } | { ok: false; error: unknown }>,
  store: FindingsStore,
  state: RunState,
  opts: { commit: boolean; startIndex?: number; log: (msg: string) => void;
          mode: 'discovery' | 'seed'; concurrency: number; startedAt: number; runId: string },
): Promise<RoundResult> {
  const { log } = opts;
  let totalAdded = 0;
  let errors = 0;
  const perCategory: CategoryOutcome[] = [];
  const telemetry: CategoryTelemetry[] = [];

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    const outcome = settled[i]!;

    const t: CategoryTelemetry = {
      key: cat.key, name: cat.name, ok: false,
      researchMs: 0, reviewMs: 0, mergeMs: 0, totalMs: 0,
      candidates: 0, reviewed: 0, added: 0, duplicates: 0, failedVerify: 0, invalid: 0,
    };

    if (!outcome.ok) {
      errors++;
      t.error = String(outcome.error);
      t.failedStage = 'research';
      telemetry.push(t);
      perCategory.push({ key: cat.key, name: cat.name, added: 0, error: t.error });
      log(`  [skip] ${cat.key}: failed after retries — ${t.error}`);
      continue;
    }

    const { reviewed, queries, researchMs, reviewMs, candidates } = outcome.value;
    t.researchMs = researchMs; t.reviewMs = reviewMs; t.candidates = candidates; t.reviewed = reviewed.length;

    const stats = { duplicates: 0, failedVerify: 0, invalid: 0 };
    const mergeStart = Date.now();
    try {
      const addedFindings = await addFindings(store, state, cat.key, reviewed, cat.researchQuery, log, stats);
      t.added = addedFindings.length;
    } catch (err) {
      errors++;
      t.error = String(err); t.failedStage = 'merge';
      t.mergeMs = Date.now() - mergeStart; t.totalMs = researchMs + reviewMs + t.mergeMs;
      telemetry.push(t);
      perCategory.push({ key: cat.key, name: cat.name, added: 0, error: t.error });
      log(`  [skip] ${cat.key}: merge failed — ${t.error}`);
      continue;
    }
    t.mergeMs = Date.now() - mergeStart;
    t.duplicates = stats.duplicates; t.failedVerify = stats.failedVerify; t.invalid = stats.invalid;
    t.totalMs = researchMs + reviewMs + t.mergeMs;
    t.ok = true;

    if (!state.queryHistory[cat.key]) state.queryHistory[cat.key] = {};
    const now = new Date().toISOString();
    for (const q of queries) state.queryHistory[cat.key]![q] = now;

    totalAdded += t.added;
    telemetry.push(t);
    perCategory.push({ key: cat.key, name: cat.name, added: t.added });
    log(`  [ok] ${cat.key}: +${t.added} new (cand=${t.candidates} rev=${t.reviewed} dup=${t.duplicates} failV=${t.failedVerify})`);

    // Persist progress atomically after each category.
    saveFindings(store);
    saveState(state);
  }

  if (typeof opts.startIndex === 'number') {
    state.categoryIndex = (opts.startIndex + categories.length) % CATEGORY_COUNT;
  }
  saveState(state);

  if (opts.commit && totalAdded > 0 && isGitRepo() && remoteExists() && hasDataChanges()) {
    commitAndPush(totalAdded, `${categories.length} categories`, log);
  }

  // Capture pi-research's own internal telemetry for this round (the tool under
  // audit). Session metrics are cumulative since SDK init; with one round per
  // process invocation this equals this round's stats.
  let piResearch = null;
  try {
    piResearch = extractRunStats(getSessionMetrics());
  } catch { /* SDK metrics unavailable (e.g. seed mode without research) */ }

  // Build + persist the pi-research audit artifact for this run.
  const run = buildRunTelemetry({
    runId: opts.runId, mode: opts.mode, startedAt: opts.startedAt, finishedAt: Date.now(),
    concurrency: opts.concurrency, totalFindingsAfter: store.findings.length, categories: telemetry,
    piResearch,
  });
  const reportPath = writeRunReport(run, DATA_DIR);
  logRunSummary(run, log);
  log(`  [audit] run report written: ${reportPath}`);

  return { totalAdded, errors, perCategory, totalFindings: store.findings.length, telemetry: run, reportPath };
}

/** Run a general-search DISCOVERY round over the given categories. */
export async function runRound(opts: RoundOptions): Promise<RoundResult> {
  const { categories, concurrency, log } = opts;
  const startedAt = Date.now();
  const runId = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-discovery`;
  const store = loadFindings();
  const state = loadState();

  await initializeResearch(log);
  log(`discovery round ${runId}: ${categories.length} categories @ concurrency ${concurrency}`);

  const settled = await mapWithConcurrency(
    categories, concurrency,
    (cat) => researchAndReview(cat, store, state, log),
  );

  return mergeAndPersist(categories, settled, store, state, {
    commit: opts.commit ?? true, startIndex: opts.startIndex, log,
    mode: 'discovery', concurrency, startedAt, runId,
  });
}

/** Run a SEED re-evaluation round over the curated legacy URLs for each category. */
export async function runSeedRound(opts: RoundOptions): Promise<RoundResult> {
  const { categories, concurrency, log } = opts;
  const startedAt = Date.now();
  const runId = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-seed`;
  const store = loadFindings();
  const state = loadState();

  await initializeResearch(log);
  log(`seed round ${runId}: ${categories.length} categories @ concurrency ${concurrency}`);

  const settled = await mapWithConcurrency(
    categories, concurrency,
    (cat) => evaluateSeeds(cat, store, state, log),
  );

  return mergeAndPersist(categories, settled, store, state, {
    commit: opts.commit ?? true, startIndex: opts.startIndex, log,
    mode: 'seed', concurrency, startedAt, runId,
  });
}
